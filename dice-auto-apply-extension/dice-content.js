let isApplyingInTab = false;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "dice-ping") {
    sendResponse({ ok: true, result: "pong" });
    return;
  }

  if (message?.type === "dice-collect-jobs") {
    collectJobsFromSearch(message.payload)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "dice-apply-single-job") {
    applySingleJobInCurrentTab(message.payload)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

async function collectJobsFromSearch(payload) {
  const maxJobsPerRun = Math.max(1, Number(payload?.maxJobsPerRun || 15));
  const history = payload?.history || {};

  if (!location.hostname.includes("dice.com")) {
    throw new Error("Job collection must run on dice.com.");
  }

  await wait(1000);
  const cards = collectJobCards();

  const jobs = [];
  for (const card of cards) {
    if (jobs.length >= maxJobsPerRun) {
      break;
    }

    const item = extractJobFromCard(card);
    if (!item) {
      continue;
    }

    if (history[item.jobId]?.status === "submitted") {
      item.previousStatus = "already_submitted";
    }

    jobs.push(item);
  }

  await log("info", "discover", "Collected jobs from search page.", {
    foundCards: cards.length,
    returnedJobs: jobs.length,
    url: location.href
  });

  return { jobs };
}

async function applySingleJobInCurrentTab(payload) {
  if (isApplyingInTab) {
    throw new Error("Apply flow already running in this tab.");
  }

  isApplyingInTab = true;

  try {
    if (!location.hostname.includes("dice.com")) {
      throw new Error("Apply flow must run on dice.com.");
    }

    const jobId = payload?.jobId || getJobIdFromUrl() || "unknown";
    const title = getDetailTitle() || "Unknown title";
    const company = getDetailCompany();
    const dryRun = Boolean(payload?.dryRun);
    const maxFormSteps = Math.max(1, Number(payload?.maxFormSteps || 10));

    await log("info", "job", "Job tab loaded for apply.", {
      jobId,
      title,
      company,
      url: location.href,
      dryRun
    });

    await waitForPageReady(12000);
    const applyButton = await waitForApplyButton(10000);
    if (!applyButton) {
      const diagnostics = getApplyDiagnostics();
      await log("warn", "job", "Apply button not found after retries.", {
        jobId,
        title,
        url: location.href,
        diagnostics
      });
      return {
        jobId,
        title,
        company,
        status: "apply_button_missing",
        details: "No easy/apply button found on job page.",
        diagnostics
      };
    }

    if (dryRun) {
      return {
        jobId,
        title,
        company,
        status: "dry_run_would_apply",
        details: "Dry run enabled; apply click skipped."
      };
    }

    const result = await attemptApply({
      applyButton,
      maxFormSteps,
      profile: payload?.profile || {}
    });

    return {
      jobId,
      title,
      company,
      status: result.status,
      details: result.details
    };
  } finally {
    isApplyingInTab = false;
  }
}

function collectJobCards() {
  const selectors = [
    "[data-cy='card-container']",
    "[id^='position-card-']",
    "article[data-jobid]",
    "article",
    ".search-card"
  ];

  const cards = [];
  const seen = new Set();

  for (const selector of selectors) {
    const found = Array.from(document.querySelectorAll(selector));
    for (const card of found) {
      const key = getJobId(card) || getCardTitle(card) || Math.random().toString(36).slice(2, 8);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      cards.push(card);
    }

    if (cards.length > 0) {
      break;
    }
  }

  if (cards.length === 0) {
    const anchors = Array.from(document.querySelectorAll("a[href*='/job-detail/']"));
    for (const anchor of anchors) {
      const card = anchor.closest("article, li, div") || anchor;
      const key = getJobId(card) || anchor.href;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      cards.push(card);
    }
  }

  return cards;
}

function extractJobFromCard(card) {
  const anchor =
    card.querySelector("a[data-cy='card-title-link']") ||
    card.querySelector("a[href*='/job-detail/']") ||
    card.querySelector("a[href*='jobId=']") ||
    card.querySelector("a");

  if (!anchor) {
    return null;
  }

  const hrefValue = anchor.getAttribute("href") || anchor.href || "";
  if (!hrefValue) {
    return null;
  }

  const url = new URL(hrefValue, location.origin).href;
  const isJobUrl = /\/job-detail\/|[?&]jobId=/i.test(url);
  if (!isJobUrl) {
    return null;
  }
  const jobId = getJobId(card) || getJobIdFromHref(url) || getJobIdFromText(card) || `unknown-${Math.random().toString(36).slice(2, 8)}`;

  return {
    jobId,
    title: getCardTitle(card),
    company: getCardCompany(card),
    url,
    easyApply: looksEasyApply(card)
  };
}

function getCardTitle(card) {
  const node =
    card.querySelector("a[data-cy='card-title-link']") ||
    card.querySelector("h5") ||
    card.querySelector("h3") ||
    card.querySelector("a[href*='/job-detail/']") ||
    card.querySelector("a");

  return normalizeText(node?.textContent || "Unknown title");
}

function getCardCompany(card) {
  const node =
    card.querySelector("[data-cy='companyNameLink']") ||
    card.querySelector("[data-cy='companyName']") ||
    card.querySelector("[data-testid='company-name']") ||
    card.querySelector(".company");

  return normalizeText(node?.textContent || "");
}

function getJobId(card) {
  if (!card) {
    return null;
  }

  const attrs = [
    card.getAttribute("data-jobid"),
    card.getAttribute("id"),
    card.dataset?.jobid,
    card.dataset?.jobId
  ];

  for (const value of attrs) {
    if (!value) {
      continue;
    }

    const normalized = String(value).replace(/^position-card-/, "").trim();
    if (normalized) {
      return normalized;
    }
  }

  const anchor = card.querySelector("a[href*='/job-detail/']") || card.querySelector("a[href*='jobId=']");
  if (!anchor) {
    return null;
  }

  return getJobIdFromHref(anchor.href || anchor.getAttribute("href") || "");
}

function getJobIdFromHref(href) {
  const detailMatch = href.match(/\/job-detail\/([^/?#]+)/i);
  if (detailMatch) {
    return decodeURIComponent(detailMatch[1]);
  }

  const queryMatch = href.match(/[?&]jobId=([^&]+)/i);
  return queryMatch ? decodeURIComponent(queryMatch[1]) : null;
}

function getJobIdFromUrl() {
  return getJobIdFromHref(location.href);
}

function getJobIdFromText(card) {
  const text = normalizeText(card.textContent || "");
  const match = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
  return match ? match[0] : null;
}

function looksEasyApply(card) {
  const text = normalizeText(card.textContent || "").toLowerCase();
  return /easy apply|quick apply|1-click apply|instant apply/.test(text);
}

function getDetailTitle() {
  const selectors = [
    "h1[data-cy='jobTitle']",
    "h1",
    "[data-testid='job-title']"
  ];

  for (const selector of selectors) {
    const node = document.querySelector(selector);
    if (node) {
      const value = normalizeText(node.textContent);
      if (value) {
        return value;
      }
    }
  }

  return "";
}

function getDetailCompany() {
  const selectors = [
    "a[data-cy='companyNameLink']",
    "[data-cy='companyName']",
    "[data-testid='company-name']",
    ".company-header"
  ];

  for (const selector of selectors) {
    const node = document.querySelector(selector);
    if (node) {
      const value = normalizeText(node.textContent);
      if (value) {
        return value;
      }
    }
  }

  return "";
}

function findApplyButton() {
  const selectorCandidates = [
    "button[data-cy*='apply' i]",
    "a[data-cy*='apply' i]",
    "button[data-testid*='apply' i]",
    "a[data-testid*='apply' i]",
    "button[aria-label*='apply' i]",
    "a[aria-label*='apply' i]",
    "button",
    "a[role='button']",
    "a"
  ];

  const seen = new Set();
  const nodes = [];
  for (const selector of selectorCandidates) {
    const found = Array.from(document.querySelectorAll(selector));
    for (const node of found) {
      if (seen.has(node)) {
        continue;
      }
      seen.add(node);
      nodes.push(node);
    }
  }

  return nodes.find((button) => isElementApplyAction(button)) || null;
}

function isElementApplyAction(element) {
  if (!isElementVisible(element)) {
    return false;
  }

  const text = normalizeText(element.textContent || "").toLowerCase();
  const aria = normalizeText(element.getAttribute("aria-label") || "").toLowerCase();
  const testId = normalizeText(element.getAttribute("data-testid") || "").toLowerCase();
  const dataCy = normalizeText(element.getAttribute("data-cy") || "").toLowerCase();
  const href = normalizeText(element.getAttribute("href") || "").toLowerCase();

  if (/save|share|report|sign in|log in|login|follow/.test(text)) {
    return false;
  }

  const combined = `${text} ${aria} ${testId} ${dataCy} ${href}`;
  return /easy apply|quick apply|instant apply|apply now|apply\b/.test(combined);
}

function getApplyDiagnostics() {
  const controls = Array.from(document.querySelectorAll("button, a[role='button'], a"))
    .filter((node) => isElementVisible(node))
    .slice(0, 40)
    .map((node) => ({
      tag: node.tagName.toLowerCase(),
      text: normalizeText(node.textContent || "").slice(0, 90),
      ariaLabel: normalizeText(node.getAttribute("aria-label") || "").slice(0, 90),
      dataCy: normalizeText(node.getAttribute("data-cy") || "").slice(0, 60),
      dataTestId: normalizeText(node.getAttribute("data-testid") || "").slice(0, 60),
      href: normalizeText(node.getAttribute("href") || "").slice(0, 120)
    }));

  return {
    title: document.title,
    url: location.href,
    visibleControlCount: controls.length,
    visibleControlsPreview: controls.slice(0, 12)
  };
}

async function waitForPageReady(timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (document.readyState === "complete") {
      break;
    }
    await wait(150);
  }
  await wait(600);
}

async function waitForApplyButton(timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const button = findApplyButton();
    if (button) {
      return button;
    }
    window.scrollTo({ top: document.body.scrollHeight / 2, behavior: "auto" });
    await wait(400);
  }
  return null;
}

async function attemptApply({ applyButton, maxFormSteps, profile }) {
  applyButton.click();
  await wait(1300);

  for (let step = 0; step < maxFormSteps; step += 1) {
    fillKnownFields(profile);

    if (hasFileUploadInput()) {
      const continueBtn = findVisibleButtonByRegex(/continue|next|review/i);
      if (continueBtn) {
        continueBtn.click();
        await wait(900);
      } else {
        return {
          status: "manual_review_required",
          details: "File upload appears required."
        };
      }
    }

    const submitBtn = findVisibleButtonByRegex(/submit|apply|finish|send/i);
    if (submitBtn) {
      submitBtn.click();
      await wait(1300);

      if (!isApplyModalOpen()) {
        return {
          status: "submitted",
          details: "Submit action completed and modal closed."
        };
      }
    }

    const nextBtn = findVisibleButtonByRegex(/continue|next|review|save and continue/i);
    if (nextBtn) {
      nextBtn.click();
      await wait(1000);
      continue;
    }

    if (!isApplyModalOpen()) {
      return {
        status: "submitted",
        details: "Apply flow closed after navigation; likely complete."
      };
    }

    return {
      status: "manual_review_required",
      details: "No deterministic next/submit control found in apply flow."
    };
  }

  return {
    status: "manual_review_required",
    details: "Reached max form steps before completing submit."
  };
}

function fillKnownFields(profile) {
  const inputs = Array.from(document.querySelectorAll("input, textarea, select"));

  for (const input of inputs) {
    if (!isElementVisible(input) || input.disabled || input.readOnly) {
      continue;
    }

    const tag = input.tagName.toLowerCase();
    if (tag === "select") {
      continue;
    }

    const type = (input.getAttribute("type") || "text").toLowerCase();
    if (["file", "hidden", "submit", "button", "radio", "checkbox"].includes(type)) {
      continue;
    }

    if ((input.value || "").trim()) {
      continue;
    }

    const context = getFieldContext(input);
    const value = resolveFieldValue(context, profile);

    if (!value) {
      continue;
    }

    input.focus();
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

function getFieldContext(input) {
  const aria = input.getAttribute("aria-label") || "";
  const placeholder = input.getAttribute("placeholder") || "";
  const name = input.getAttribute("name") || "";
  const id = input.getAttribute("id") || "";

  let labelText = "";
  if (id) {
    const label = document.querySelector(`label[for='${cssEscape(id)}']`);
    labelText = normalizeText(label?.textContent || "");
  }

  if (!labelText) {
    labelText = normalizeText(input.closest("label")?.textContent || "");
  }

  return [aria, placeholder, name, labelText].join(" ").toLowerCase();
}

function resolveFieldValue(context, profile) {
  if (/full name|legal name|first name|last name|name/.test(context)) {
    return profile.fullName || "";
  }
  if (/email/.test(context)) {
    return profile.email || "";
  }
  if (/phone|mobile|cell/.test(context)) {
    return profile.phone || "";
  }
  if (/city|location|address/.test(context)) {
    return profile.city || "";
  }
  if (/linkedin/.test(context)) {
    return profile.linkedin || "";
  }
  if (/website|portfolio|github/.test(context)) {
    return profile.website || "";
  }
  if (/salary|compensation|pay/.test(context)) {
    return profile.salaryExpectation || "";
  }
  if (/authorization|sponsor|visa/.test(context)) {
    return profile.workAuthorization || "";
  }
  return "";
}

function findVisibleButtonByRegex(regex) {
  const buttons = Array.from(document.querySelectorAll("button, a[role='button'], a"));
  return (
    buttons.find((button) => {
      if (!isElementVisible(button)) {
        return false;
      }
      const text = normalizeText(button.textContent || "");
      return regex.test(text);
    }) || null
  );
}

function hasFileUploadInput() {
  const fileInput = document.querySelector("input[type='file']");
  return Boolean(fileInput && isElementVisible(fileInput));
}

function isApplyModalOpen() {
  const selectors = ["[role='dialog']", ".modal", ".drawer", ".apply-modal"];
  const nodes = selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)));
  return nodes.some((node) => isElementVisible(node));
}

function isElementVisible(element) {
  if (!element) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);

  return (
    rect.width > 0 &&
    rect.height > 0 &&
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    style.opacity !== "0"
  );
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === "function") {
    return window.CSS.escape(value);
  }
  return value.replace(/['"\\]/g, "");
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function log(level, source, message, data = {}) {
  try {
    await chrome.runtime.sendMessage({
      type: "automation-log",
      level,
      source,
      message,
      data
    });
  } catch (error) {
    // Ignore log failures.
  }
}
