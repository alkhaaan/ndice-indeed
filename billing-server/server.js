import cors from "cors";
import "dotenv/config";
import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import Stripe from "stripe";

const app = express();
const stripe = new Stripe(requiredEnv("STRIPE_SECRET_KEY"));

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_BASE_URL = requiredEnv("PUBLIC_BASE_URL").replace(/\/$/, "");
const WEBHOOK_SECRET = requiredEnv("STRIPE_WEBHOOK_SECRET");
const SUCCESS_URL = process.env.SUCCESS_URL || `${PUBLIC_BASE_URL}/billing/success`;
const CANCEL_URL = process.env.CANCEL_URL || `${PUBLIC_BASE_URL}/billing/cancel`;
const EXTENSION_ORIGIN = process.env.EXTENSION_ORIGIN || "";
const STORE_PATH = path.join(process.cwd(), "data", "subscriptions.json");
const PLAN_CATALOG = {
  starter: {
    name: "Starter",
    slug: "starter-monthly",
    priceId: requiredEnv("STRIPE_STARTER_MONTHLY_PRICE_ID"),
    dailyApplicationLimit: 100,
    unlimitedApplications: false
  },
  pro: {
    name: "Pro",
    slug: "pro-monthly",
    priceId: requiredEnv("STRIPE_PRO_MONTHLY_PRICE_ID"),
    dailyApplicationLimit: 450,
    unlimitedApplications: false
  },
  unlimited: {
    name: "Unlimited",
    slug: "unlimited-monthly",
    priceId: requiredEnv("STRIPE_UNLIMITED_MONTHLY_PRICE_ID"),
    dailyApplicationLimit: null,
    unlimitedApplications: true
  }
};

app.post("/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const signature = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, signature, WEBHOOK_SECRET);
  } catch (error) {
    res.status(400).send(`Webhook signature verification failed: ${error.message}`);
    return;
  }

  try {
    await handleStripeEvent(event);
    res.json({ received: true });
  } catch (error) {
    console.error("Webhook handler failed", error);
    res.status(500).json({ error: "webhook_handler_failed" });
  }
});

app.use(express.json());
app.use(cors({
  origin(origin, callback) {
    if (!origin || origin === PUBLIC_BASE_URL || origin === EXTENSION_ORIGIN) {
      callback(null, true);
      return;
    }
    callback(new Error("Origin not allowed"));
  }
}));

app.get("/billing/checkout", async (req, res) => {
  const email = normalizeEmail(req.query.email);
  const licenseKey = normalizeLicenseKey(req.query.license_key);
  const planKey = resolvePlanKey(req.query.plan);
  const plan = PLAN_CATALOG[planKey];

  if (!email || !licenseKey) {
    res.status(400).send("Missing billing email or license key. Enter both in the extension and try again.");
    return;
  }

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer_email: email,
    line_items: [{ price: plan.priceId, quantity: 1 }],
    success_url: `${SUCCESS_URL}?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: CANCEL_URL,
    client_reference_id: licenseKey,
    metadata: {
      product: "NDice Indeed",
      plan: plan.slug,
      license_key: licenseKey,
      email
    },
    subscription_data: {
      metadata: {
        product: "NDice Indeed",
        plan: plan.slug,
        license_key: licenseKey,
        email
      }
    }
  });

  res.redirect(303, session.url);
});

app.get("/billing/portal", async (req, res) => {
  const email = normalizeEmail(req.query.email);
  const licenseKey = normalizeLicenseKey(req.query.license_key);
  const record = await findSubscriptionRecord({ email, licenseKey });

  if (!record?.stripeCustomerId) {
    res.status(404).send("No Stripe customer found for this email/license key yet.");
    return;
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: record.stripeCustomerId,
    return_url: PUBLIC_BASE_URL
  });

  res.redirect(303, session.url);
});

app.post("/api/subscription/validate", async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const licenseKey = normalizeLicenseKey(req.body?.licenseKey);

  if (!email || !licenseKey) {
    res.json(freeResponse("missing_credentials"));
    return;
  }

  const record = await findSubscriptionRecord({ email, licenseKey });
  if (!record?.stripeSubscriptionId) {
    res.json(freeResponse("not_found"));
    return;
  }

  const subscription = await stripe.subscriptions.retrieve(record.stripeSubscriptionId);
  const active = ["active", "trialing"].includes(subscription.status);
  const planKey = resolvePlanKey(subscription.metadata?.plan || record.plan);
  const plan = PLAN_CATALOG[planKey];
  const currentPeriodEnd = subscription.current_period_end
    ? new Date(subscription.current_period_end * 1000).toISOString()
    : null;

  await upsertSubscriptionRecord({
    ...record,
    email,
    licenseKey,
    plan: plan.slug,
    status: subscription.status,
    currentPeriodEnd,
    updatedAt: new Date().toISOString()
  });

  res.json({
    plan: active ? planKey : "free",
    planName: active ? plan.name : "Free",
    status: subscription.status,
    active,
    currentPeriodEnd,
    customerPortalUrl: `${PUBLIC_BASE_URL}/billing/portal?email=${encodeURIComponent(email)}&license_key=${encodeURIComponent(licenseKey)}`,
    entitlements: {
      dailyApplicationLimit: active ? plan.dailyApplicationLimit : 10,
      unlimitedApplications: active && plan.unlimitedApplications
    }
  });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`NDice Indeed billing server listening on port ${PORT}`);
});

async function handleStripeEvent(event) {
  switch (event.type) {
    case "checkout.session.completed":
      await handleCheckoutCompleted(event.data.object);
      break;
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      await handleSubscriptionChanged(event.data.object);
      break;
    default:
      break;
  }
}

async function handleCheckoutCompleted(session) {
  const licenseKey = normalizeLicenseKey(session.client_reference_id || session.metadata?.license_key);
  const email = normalizeEmail(session.customer_details?.email || session.customer_email || session.metadata?.email);
  if (!licenseKey || !email) {
    return;
  }

  await upsertSubscriptionRecord({
    email,
    licenseKey,
    plan: resolvePlanSlug(session.metadata?.plan),
    stripeCustomerId: session.customer,
    stripeSubscriptionId: session.subscription,
    status: "checkout_completed",
    updatedAt: new Date().toISOString()
  });
}

async function handleSubscriptionChanged(subscription) {
  const licenseKey = normalizeLicenseKey(subscription.metadata?.license_key);
  const email = normalizeEmail(subscription.metadata?.email);
  if (!licenseKey || !email) {
    return;
  }

  await upsertSubscriptionRecord({
    email,
    licenseKey,
    plan: resolvePlanSlug(subscription.metadata?.plan),
    stripeCustomerId: subscription.customer,
    stripeSubscriptionId: subscription.id,
    status: subscription.status,
    currentPeriodEnd: subscription.current_period_end
      ? new Date(subscription.current_period_end * 1000).toISOString()
      : null,
    updatedAt: new Date().toISOString()
  });
}

async function findSubscriptionRecord({ email, licenseKey }) {
  const store = await readStore();
  const byKey = store[licenseKey];
  if (byKey && (!email || byKey.email === email)) {
    return byKey;
  }
  return Object.values(store).find((record) => record.email === email && record.licenseKey === licenseKey) || null;
}

async function upsertSubscriptionRecord(record) {
  const store = await readStore();
  store[record.licenseKey] = {
    ...store[record.licenseKey],
    ...record
  };
  await writeStore(store);
}

async function readStore() {
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function writeStore(store) {
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
  await fs.writeFile(STORE_PATH, JSON.stringify(store, null, 2));
}

function freeResponse(status) {
  return {
    plan: "free",
    planName: "Free",
    status,
    active: false,
    entitlements: {
      dailyApplicationLimit: 10,
      unlimitedApplications: false
    }
  };
}

function resolvePlanKey(value) {
  const raw = String(value || "").trim().toLowerCase().replace(/_/g, "-");
  if (raw === "pro" || raw === "pro-monthly") {
    return "pro";
  }
  if (raw === "unlimited" || raw === "unlimited-monthly") {
    return "unlimited";
  }
  return "starter";
}

function resolvePlanSlug(value) {
  return PLAN_CATALOG[resolvePlanKey(value)].slug;
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeLicenseKey(value) {
  return String(value || "").trim().toUpperCase();
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
