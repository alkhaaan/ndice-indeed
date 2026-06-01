const STORAGE_KEYS = {
  SETTINGS: "automationSettings",
  LOGS: "automationLogs",
  JOB_HISTORY: "jobHistory",
  DAILY_USAGE: "dailyUsage",
  SUBSCRIPTION: "subscriptionState",
  SLOT_RUNS: "slotRuns",
  SCHEDULE_PLANS: "schedulePlans",
  STATE: "automationState"
};

const ALARM_HEARTBEAT = "automation-heartbeat";
const RUN_STALE_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_JOB_HISTORY_ENTRIES = 5000;
const PLAN_CATALOG = {
  free: {
    name: "Free",
    slug: "free",
    priceLabel: "$0",
    dailyApplicationLimit: 10,
    unlimitedApplications: false
  },
  starter: {
    name: "Starter",
    slug: "starter-monthly",
    priceLabel: "$9.99/month",
    dailyApplicationLimit: 100,
    unlimitedApplications: false
  },
  pro: {
    name: "Pro",
    slug: "pro-monthly",
    priceLabel: "$22.99/month",
    dailyApplicationLimit: 450,
    unlimitedApplications: false
  },
  unlimited: {
    name: "Unlimited",
    slug: "unlimited-monthly",
    priceLabel: "$35.99/month",
    dailyApplicationLimit: null,
    unlimitedApplications: true
  }
};
const DEFAULT_CHECKOUT_PLAN = "starter";
const FREE_DAILY_APPLICATION_LIMIT = PLAN_CATALOG.free.dailyApplicationLimit;
const SUBSCRIPTION_GRACE_PERIOD_MS = 72 * 60 * 60 * 1000;
const LIMITS = {
  maxJobsPerRun: { min: 1, max: 450, fallback: 15 },
  maxPaginationPages: { min: 1, max: 25, fallback: 5 },
  maxFormSteps: { min: 1, max: 30, fallback: 10 }
};
const DAILY_RANDOM_SLOT_COUNT = 3;
const QUIET_HOURS = {
  startMinutes: 23 * 60,
  endMinutes: 5 * 60
};
const ACTIVE_MINUTES = {
  start: QUIET_HOURS.endMinutes,
  end: QUIET_HOURS.startMinutes - 1
};

const DEFAULT_SETTINGS = {
  scheduleEnabled: true,
  searchUrl: "https://www.dice.com/jobs?q=&filters.postedDate=ONE&sort=DATE",
  maxJobsPerRun: 15,
  maxPaginationPages: 10,
  scheduleWindowMinutes: 12,
  maxFormSteps: 10,
  dryRun: false,
  billing: {
    checkoutUrl: "https://ndiceindeed.com/billing/checkout",
    portalUrl: "https://ndiceindeed.com/billing/portal",
    validationUrl: "https://ndiceindeed.com/api/subscription/validate"
  },
  subscriptionAuth: {
    email: "",
    licenseKey: ""
  },
  profile: {
    fullName: "",
    email: "",
    phone: "",
    city: "",
    linkedin: "",
    website: "",
    salaryExpectation: "",
    workAuthorization: ""
  }
};

chrome.runtime.onInstalled.addListener(async () => {
  await initializeDefaults();
  await setupScheduler();
  await appendLog("info", "background", "Dice extension installed and scheduler initialized.");
});

chrome.runtime.onStartup.addListener(async () => {
  await setupScheduler();
  await recoverStaleRunLock({ force: true, reason: "browser_startup" });
  await appendLog("info", "background", "Browser startup: scheduler verified.");
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_HEARTBEAT) {
    await checkScheduledRun();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "automation-get-settings":
      return getSettings();
    case "automation-save-settings":
      return saveSettings(message.payload || {});
    case "automation-run-now":
      await clearStopRequest("manual_run");
      return runAutomation("manual");
    case "automation-stop":
      return requestStopAutomation();
    case "automation-get-logs":
      return getLogs();
    case "automation-clear-logs":
      return clearLogs();
    case "automation-reset-submitted-history":
      return resetSubmittedHistory();
    case "automation-get-status":
      return getStatus();
    case "subscription-open-checkout":
      return openSubscriptionCheckout(message.payload || {});
    case "subscription-open-portal":
      return openSubscriptionPortal();
    case "subscription-refresh":
      return refreshSubscriptionStatus();
    case "automation-log":
      await appendLog(message.level || "info", message.source || "content", message.message || "", message.data || {}, sender);
      return { logged: true };
    default:
      throw new Error("Unknown message type.");
  }
}

async function initializeDefaults() {
  const settings = await getStorage(STORAGE_KEYS.SETTINGS);
  if (!settings) {
    await setStorage(STORAGE_KEYS.SETTINGS, DEFAULT_SETTINGS);
  }

  const slotRuns = await getStorage(STORAGE_KEYS.SLOT_RUNS);
  if (!slotRuns) {
    await setStorage(STORAGE_KEYS.SLOT_RUNS, {});
  }

  const schedulePlans = await getStorage(STORAGE_KEYS.SCHEDULE_PLANS);
  if (!schedulePlans) {
    await setStorage(STORAGE_KEYS.SCHEDULE_PLANS, {});
  }

  const state = await getStorage(STORAGE_KEYS.STATE);
  if (!state) {
    await setStorage(STORAGE_KEYS.STATE, {
      inProgress: false,
      lastRunAt: null,
      lastRunResult: null,
      currentRunId: null,
      runStartedAt: null,
      stopRequested: false
    });
  }

  const logs = await getStorage(STORAGE_KEYS.LOGS);
  if (!Array.isArray(logs)) {
    await setStorage(STORAGE_KEYS.LOGS, []);
  }

  const jobHistory = await getStorage(STORAGE_KEYS.JOB_HISTORY);
  if (!jobHistory || typeof jobHistory !== "object") {
    await setStorage(STORAGE_KEYS.JOB_HISTORY, {});
  }

  const dailyUsage = await getStorage(STORAGE_KEYS.DAILY_USAGE);
  if (!dailyUsage || typeof dailyUsage !== "object") {
    await setStorage(STORAGE_KEYS.DAILY_USAGE, {});
  }

  const subscription = await getStorage(STORAGE_KEYS.SUBSCRIPTION);
  if (!subscription || typeof subscription !== "object") {
    await setStorage(STORAGE_KEYS.SUBSCRIPTION, buildFreeSubscriptionState("not_checked"));
  }
}

async function setupScheduler() {
  await createAlarm(ALARM_HEARTBEAT, { periodInMinutes: 1 });
}

async function checkScheduledRun() {
  const settings = await getSettings();
  if (!settings.scheduleEnabled) {
    return;
  }
  const state = (await getStorage(STORAGE_KEYS.STATE)) || {};
  if (state.stopRequested) {
    return;
  }

  const now = new Date();
  const minutesNowLocal = now.getHours() * 60 + now.getMinutes();
  const dateKey = getLocalDateKey(now);
  const schedulePlan = await getOrCreateDailySchedulePlan(dateKey);

  for (const slot of schedulePlan.slots) {
    const withinWindow = minutesNowLocal >= slot.minutes && minutesNowLocal <= slot.minutes + settings.scheduleWindowMinutes;
    if (!withinWindow) {
      continue;
    }

    const slotRunKey = `${dateKey}-${slot.key}`;
    const slotRuns = (await getStorage(STORAGE_KEYS.SLOT_RUNS)) || {};

    if (slotRuns[slotRunKey]) {
      continue;
    }

    slotRuns[slotRunKey] = {
      slot: slot.key,
      dateKey,
      startedAt: new Date().toISOString()
    };

    await pruneOldSlotRuns(slotRuns);
    await setStorage(STORAGE_KEYS.SLOT_RUNS, slotRuns);

    await appendLog("info", "scheduler", `Scheduled run triggered for local slot ${slot.key}.`, {
      dateKey,
      minutesNowLocal,
      localTimeZone: getLocalTimeZone()
    });

    await runAutomation(`scheduled-${slot.key}`);
    return;
  }
}

async function runAutomation(trigger) {
  await recoverStaleRunLock();
  const state = (await getStorage(STORAGE_KEYS.STATE)) || {};
  if (state.stopRequested && trigger !== "manual") {
    await appendLog("warn", "background", "Run skipped because stop was requested.", { trigger });
    return { skipped: true, reason: "stop_requested" };
  }
  if (state.inProgress) {
    await appendLog("warn", "background", "Run skipped because another run is already in progress.", {
      trigger,
      currentRunId: state.currentRunId
    });
    return { skipped: true, reason: "in_progress" };
  }

  const settings = await getSettings();
  const subscription = await getSubscriptionStatus();
  const planLimit = getSubscriptionDailyLimit(subscription);
  const hasUnlimitedApplications = Boolean(subscription.entitlements?.unlimitedApplications);
  const todayUsage = await getDailyUsageForToday();
  const remainingDailyApplications = hasUnlimitedApplications ? Infinity : Math.max(0, planLimit - todayUsage.submittedCount);
  if (!settings.dryRun && !hasUnlimitedApplications && remainingDailyApplications <= 0) {
    await appendLog("warn", "background", "Run skipped because daily application limit was reached.", {
      trigger,
      dailyLimit: planLimit,
      submittedToday: todayUsage.submittedCount
    });
    return { skipped: true, reason: "daily_limit_reached" };
  }

  const resolvedSearchUrl = normalizeDiceSearchUrl(settings.searchUrl);
  const maxJobsPerRun = clampNumber(settings.maxJobsPerRun, LIMITS.maxJobsPerRun);
  const effectiveMaxJobsPerRun = hasUnlimitedApplications || settings.dryRun ? maxJobsPerRun : Math.min(maxJobsPerRun, remainingDailyApplications);
  const maxPaginationPages = clampNumber(settings.maxPaginationPages, LIMITS.maxPaginationPages);
  const maxFormSteps = clampNumber(settings.maxFormSteps, LIMITS.maxFormSteps);
  const history = (await getStorage(STORAGE_KEYS.JOB_HISTORY)) || {};
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  await setStorage(STORAGE_KEYS.STATE, {
    ...state,
    inProgress: true,
    currentRunId: runId,
    runStartedAt: new Date().toISOString()
  });

  await appendLog("info", "background", "Automation run started.", {
    runId,
    trigger,
    dryRun: settings.dryRun,
    maxJobsPerRun,
    effectiveMaxJobsPerRun,
    maxPaginationPages,
    searchUrl: resolvedSearchUrl,
    subscriptionPlan: subscription.plan,
    subscriptionStatus: subscription.status,
    dailyApplicationLimit: hasUnlimitedApplications ? "unlimited" : planLimit,
    submittedToday: todayUsage.submittedCount,
    remainingDailyApplications: Number.isFinite(remainingDailyApplications) ? remainingDailyApplications : "unlimited"
  });

  try {
    const sourceTab = await resolveSourceTab(trigger, resolvedSearchUrl);
    await ensureContentScript(sourceTab.id);

    const jobs = [];
    await ensureListingTabStartsFromPageOne(sourceTab.id);
    const baseTab = await getTabSafe(sourceTab.id);
    const startUrl = String(baseTab?.url || "");
    const seenDiscovered = new Set();
    let shouldStopPaging = false;
    let submittedToday = todayUsage.submittedCount;

    for (let page = 1; page <= maxPaginationPages; page += 1) {
      if (shouldStopPaging || jobs.length >= effectiveMaxJobsPerRun) {
        break;
      }

      const targetUrl = buildListingPageUrl(startUrl, page);
      if (!targetUrl) {
        break;
      }

      const currentTab = await getTabSafe(sourceTab.id);
      const currentUrl = String(currentTab?.url || "");
      if (currentUrl !== targetUrl) {
        await updateTab(sourceTab.id, { url: targetUrl, active: true });
        await waitForTabComplete(sourceTab.id, 30000);
      }

      await ensureContentScript(sourceTab.id);

      let pageJobs = [];
      try {
        pageJobs = await collectJobsFromSinglePage(sourceTab.id, {
          maxJobsPerRun: effectiveMaxJobsPerRun,
          maxPaginationPages: 1,
          history
        });
      } catch (error) {
        const recoverable = isMessageChannelClosedError(error) || isNoReceivingEndError(error);
        if (!recoverable) {
          throw error;
        }

        await appendLog("warn", "background", "Collect jobs page failed; reloading tab and retrying once.", {
          runId,
          sourceTabId: sourceTab.id,
          page,
          error: error.message
        });

        const tabAfterFailure = await getTabSafe(sourceTab.id);
        const recoveryUrl = String(tabAfterFailure?.url || targetUrl);
        await updateTab(sourceTab.id, { url: recoveryUrl, active: true });
        await waitForTabComplete(sourceTab.id, 30000);
        await ensureContentScript(sourceTab.id);
        pageJobs = await collectJobsFromSinglePage(sourceTab.id, {
          maxJobsPerRun: effectiveMaxJobsPerRun,
          maxPaginationPages: 1,
          history
        });
      }

      const pageCandidates = [];
      for (const job of pageJobs) {
        const key = `${job?.jobId || ""}|${job?.url || ""}`;
        if (seenDiscovered.has(key)) {
          continue;
        }
        seenDiscovered.add(key);
        pageCandidates.push(job);
      }

      await appendLog("info", "background", "Collected jobs from listing page.", {
        runId,
        sourceTabId: sourceTab.id,
        page,
        collectedOnPage: pageCandidates.length
      });

      if (pageCandidates.length === 0) {
        break;
      }

      for (const job of pageCandidates) {
        if (jobs.length >= effectiveMaxJobsPerRun) {
          shouldStopPaging = true;
          break;
        }

        const jobId = job.jobId || `job-${Math.random().toString(36).slice(2, 9)}`;
        const title = job.title || "Unknown title";

        const priorStatus = history[jobId]?.status;
        if (priorStatus === "already_submitted") {
          jobs.push({ jobId, title, status: "already_submitted", skipped: true });
          continue;
        }
        if (priorStatus === "submitted" && job.alreadyApplied) {
          jobs.push({ jobId, title, status: "already_submitted", skipped: true });
          continue;
        }
        if (priorStatus === "submitted" && !job.alreadyApplied) {
          await appendLog("warn", "background", "History marked job submitted but listing is not Applied; retrying job.", {
            runId,
            jobId,
            title
          });
        }
        if (job.alreadyApplied) {
          jobs.push({ jobId, title, status: "already_submitted", skipped: true, details: "Skipped because listing indicates already applied." });
          continue;
        }

        if (!job.url) {
          jobs.push({ jobId, title, status: "missing_job_url", skipped: true });
          continue;
        }

        let jobTab = null;
        try {
          if (!settings.dryRun && !hasUnlimitedApplications && submittedToday >= planLimit) {
            await appendLog("warn", "background", "Stopping run after reaching daily application limit.", {
              runId,
              dailyLimit: planLimit,
              submittedToday
            });
            shouldStopPaging = true;
            break;
          }

          if (await isStopRequested()) {
            await appendLog("warn", "background", "Run stopping by user request before opening next job tab.", {
              runId,
              jobId
            });
            shouldStopPaging = true;
            break;
          }
          await appendLog("info", "background", "Opening job tab.", { runId, jobId, title, url: job.url, page });

          jobTab = await createTabWithRetry({ url: job.url, active: true });
          await waitForTabComplete(jobTab.id, 60000);
          await ensureContentScript(jobTab.id);

          let applyResult = null;
          try {
            const applyResponse = await sendTabMessage(jobTab.id, {
              type: "dice-apply-single-job",
              payload: {
                jobId,
                profile: settings.profile || {},
                dryRun: Boolean(settings.dryRun),
                maxFormSteps
              }
            });
            applyResult = applyResponse?.result || {};
          } catch (error) {
            if (!isMessageChannelClosedError(error)) {
              throw error;
            }

            // Some Dice apply actions navigate away quickly and close the content-script channel
            // before sendResponse can return. Probe the page state once more before deciding.
            applyResult = await inferOutcomeAfterChannelClose({
              tabId: jobTab.id,
              jobId,
              title,
              company: job.company || "",
              profile: settings.profile || {},
              maxFormSteps
            });
          }

          jobs.push({
            jobId,
            title: applyResult.title || title,
            company: applyResult.company || job.company || "",
            status: applyResult.status || "unknown",
            details: applyResult.details || ""
          });

          if (!settings.dryRun && applyResult.status === "submitted") {
            submittedToday += 1;
            await incrementDailySubmittedCount(1);
          }

          await appendLog(
            applyResult.status === "submitted" ? "info" : "warn",
            "background",
            "Job tab finished.",
            {
              runId,
              jobId,
              title: applyResult.title || title,
              status: applyResult.status || "unknown",
              details: applyResult.details || "",
              page
            }
          );
        } catch (error) {
          jobs.push({
            jobId,
            title,
            status: "tab_flow_error",
            details: error.message
          });

          await appendLog("error", "background", "Job tab failed.", {
            runId,
            jobId,
            title,
            page,
            error: error.message
          });
        } finally {
          if (jobTab?.id) {
            await safeCloseTab(jobTab.id);
            await appendLog("info", "background", "Closed job tab.", { runId, jobId, tabId: jobTab.id });
          }
        }
      }
    }

    await mergeJobHistory(jobs);
    const summary = buildSummary(jobs);

    const runResult = {
      status: "completed",
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      summary,
      jobs
    };

    await appendLog("info", "background", "Automation run finished.", {
      runId,
      trigger,
      summary,
      status: "completed"
    });

    const latestState = (await getStorage(STORAGE_KEYS.STATE)) || {};
    await setStorage(STORAGE_KEYS.STATE, {
      ...latestState,
      inProgress: false,
      lastRunAt: new Date().toISOString(),
      lastRunResult: runResult,
      currentRunId: null,
      runStartedAt: null
    });

    return { runId, runResult };
  } catch (error) {
    await appendLog("error", "background", "Automation run failed.", {
      runId,
      trigger,
      error: error.message
    });

    const latestState = (await getStorage(STORAGE_KEYS.STATE)) || {};
    await setStorage(STORAGE_KEYS.STATE, {
      ...latestState,
      inProgress: false,
      lastRunAt: new Date().toISOString(),
      lastRunResult: { status: "error", error: error.message },
      currentRunId: null,
      runStartedAt: null
    });

    throw error;
  }
}

async function resolveSourceTab(trigger, searchUrl) {
  if (trigger === "manual") {
    const current = await queryTabs({ active: true, currentWindow: true });
    const activeTab = current[0];
    if (activeTab?.url && activeTab.url.includes("dice.com/jobs")) {
      return activeTab;
    }
  }

  return prepareDiceSearchTab(searchUrl);
}

async function prepareDiceSearchTab(searchUrl) {
  const tabs = await queryTabs({ url: ["https://*.dice.com/*"] });
  let tab = tabs.find((item) => item.url && item.url.includes("dice.com/jobs"));

  if (tab) {
    tab = await updateTab(tab.id, { url: searchUrl, active: false });
  } else {
    tab = await createTab({ url: searchUrl, active: false });
  }

  await waitForTabComplete(tab.id, 30000);
  return tab;
}

async function ensureContentScript(tabId) {
  try {
    await sendTabMessage(tabId, { type: "dice-ping" });
  } catch (error) {
    await executeScript(tabId, ["dice-content.js"]);
    await sendTabMessage(tabId, { type: "dice-ping" });
  }
}

async function resetSubmittedHistory() {
  const history = (await getStorage(STORAGE_KEYS.JOB_HISTORY)) || {};
  let removed = 0;

  for (const [jobId, entry] of Object.entries(history)) {
    const status = entry?.status;
    if (status === "submitted" || status === "already_submitted") {
      delete history[jobId];
      removed += 1;
    }
  }

  await setStorage(STORAGE_KEYS.JOB_HISTORY, history);
  await appendLog("warn", "popup", "Submitted history reset by user.", { removed });
  return { removed };
}

async function collectListingJobs(tabId, payload) {
  const maxPaginationPages = Math.max(1, Math.min(25, Number(payload?.maxPaginationPages || 5)));
  await ensureListingTabStartsFromPageOne(tabId);

  const tab = await getTabSafe(tabId);
  const startUrl = String(tab?.url || "");
  const aggregated = [];
  const seen = new Set();

  for (let page = 1; page <= maxPaginationPages; page += 1) {
    const targetUrl = buildListingPageUrl(startUrl, page);
    if (!targetUrl) {
      break;
    }

    const currentTab = await getTabSafe(tabId);
    const currentUrl = String(currentTab?.url || "");
    if (currentUrl !== targetUrl) {
      await updateTab(tabId, { url: targetUrl, active: false });
      await waitForTabComplete(tabId, 30000);
    }

    await ensureContentScript(tabId);

    let pageJobs = [];
    try {
      pageJobs = await collectJobsFromSinglePage(tabId, payload);
    } catch (error) {
      const recoverable = isMessageChannelClosedError(error) || isNoReceivingEndError(error);
      if (!recoverable) {
        throw error;
      }

      await appendLog("warn", "background", "Collect jobs page failed; reloading tab and retrying once.", {
        tabId,
        page,
        error: error.message
      });

      const tabAfterFailure = await getTabSafe(tabId);
      const recoveryUrl = String(tabAfterFailure?.url || targetUrl);
      await updateTab(tabId, { url: recoveryUrl, active: false });
      await waitForTabComplete(tabId, 30000);
      await ensureContentScript(tabId);
      pageJobs = await collectJobsFromSinglePage(tabId, payload);
    }

    if (pageJobs.length === 0) {
      break;
    }

    for (const job of pageJobs) {
      const key = `${job?.jobId || ""}|${job?.url || ""}`;
      if (!seen.has(key)) {
        seen.add(key);
        aggregated.push(job);
      }
    }
  }

  return aggregated;
}

async function collectJobsFromSinglePage(tabId, payload) {
  const listingResponse = await sendTabMessageResilient(tabId, {
    type: "dice-collect-jobs",
    payload: {
      ...payload,
      startFromFirstPage: false,
      maxPaginationPages: 1
    }
  });
  return listingResponse?.result?.jobs || [];
}

async function ensureListingTabStartsFromPageOne(tabId) {
  const tab = await getTabSafe(tabId);
  const currentUrl = String(tab?.url || "");
  if (!currentUrl) {
    return;
  }

  const pageOneUrl = buildPageOneListingUrl(currentUrl);
  if (!pageOneUrl || pageOneUrl === currentUrl) {
    return;
  }

  await updateTab(tabId, { url: pageOneUrl, active: false });
  await waitForTabComplete(tabId, 30000);
}

function buildPageOneListingUrl(currentUrl) {
  try {
    const parsed = new URL(currentUrl);
    if (!/(\.|^)dice\.com$/i.test(parsed.hostname) || !parsed.pathname.includes("/jobs")) {
      return null;
    }
    const page = Number(parsed.searchParams.get("page") || "1");
    if (!Number.isFinite(page) || page <= 1) {
      return null;
    }
    parsed.searchParams.delete("page");
    return parsed.href;
  } catch (error) {
    return null;
  }
}

function buildListingPageUrl(baseUrl, page) {
  try {
    const parsed = new URL(baseUrl);
    if (!/(\.|^)dice\.com$/i.test(parsed.hostname) || !parsed.pathname.includes("/jobs")) {
      return null;
    }
    if (page <= 1) {
      parsed.searchParams.delete("page");
    } else {
      parsed.searchParams.set("page", String(page));
    }
    return parsed.href;
  } catch (error) {
    return null;
  }
}

async function safeCloseTab(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.remove(tabId, () => {
      resolve();
    });
  });
}

async function createTabWithRetry(createProperties, maxAttempts = 4) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await createTab(createProperties);
    } catch (error) {
      lastError = error;
      const retriable = /Tabs cannot be edited right now/i.test(error.message || "");
      if (!retriable || attempt === maxAttempts) {
        throw error;
      }
      await wait(350 * attempt);
    }
  }
  throw lastError || new Error("Failed to create tab.");
}

function isMessageChannelClosedError(error) {
  const message = String(error?.message || "");
  return (
    /message channel closed before a response was received/i.test(message) ||
    /message channel closed/i.test(message) ||
    /back\/forward cache/i.test(message) ||
    /moved into back\/forward cache/i.test(message) ||
    /extension port .* closed/i.test(message)
  );
}

async function inferOutcomeAfterChannelClose({ tabId, jobId, title, company, profile, maxFormSteps }) {
  let lastUrl = "";
  let lastTabTitle = "";
  let inferredTitle = title;

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await wait(1100);
    const tab = await getTabSafe(tabId);
    if (!tab) {
      return {
        title: inferredTitle,
        company,
        status: "manual_review_required",
        details: "Apply flow navigated before confirmation and tab became unavailable."
      };
    }

    lastUrl = String(tab.url || "");
    lastTabTitle = String(tab.title || "");
    if (lastTabTitle && inferredTitle === "Unknown title") {
      inferredTitle = lastTabTitle;
    }

    try {
      if (lastUrl.includes("dice.com")) {
        await ensureContentScript(tabId);
        const probeResponse = await sendTabMessage(tabId, { type: "dice-probe-apply-outcome" });
        const probe = probeResponse?.result || {};
        if (probe.title && inferredTitle === "Unknown title") {
          inferredTitle = probe.title;
        }
        if (probe.status === "submitted" || probe.status === "already_submitted") {
          return {
            title: probe.title || inferredTitle,
            company,
            status: probe.status,
            details: probe.status === "already_submitted"
              ? "Already-applied state inferred from post-navigation signals."
              : "Submission inferred from post-navigation confirmation signals.",
            evidence: probe.evidence || {}
          };
        }
      }
    } catch (error) {
      // Continue polling; some transitions temporarily detach the content script.
    }

    const combined = `${lastUrl} ${lastTabTitle}`.toLowerCase();
    if (/application-submitted|apply-confirmation|thank|submitted/.test(combined)) {
      return {
        title: inferredTitle,
        company,
        status: "submitted",
        details: "Submission inferred from URL/title after channel closed."
      };
    }

    if (lastUrl && !lastUrl.includes("dice.com")) {
      return {
        title: inferredTitle,
        company,
        status: "manual_review_required",
        details: "Redirected to external application page; manual completion may be required."
      };
    }

    const isDiceWizard = /dice\.com\/job-applications\/.+\/wizard/i.test(lastUrl);
    if (isDiceWizard) {
      try {
        await ensureContentScript(tabId);
        const wizardResponse = await sendTabMessage(tabId, {
          type: "dice-complete-wizard",
          payload: {
            profile: profile || {},
            maxFormSteps: Math.max(8, Number(maxFormSteps || 10))
          }
        });
        const wizardResult = wizardResponse?.result || {};
        if (wizardResult.status === "submitted") {
          return {
            title: inferredTitle,
            company,
            status: "submitted",
            details: wizardResult.details || "Wizard automation completed with submission."
          };
        }

        return {
          title: inferredTitle,
          company,
          status: wizardResult.status || "manual_review_required",
          details: wizardResult.details || "Wizard automation could not reach final submit."
        };
      } catch (error) {
        return {
          title: inferredTitle,
          company,
          status: "manual_review_required",
          details: `Wizard automation error: ${error.message}`
        };
      }
    }
  }

  return {
    title: inferredTitle,
    company,
    status: "manual_review_required",
    details: `Apply flow navigated before confirmation; verify submission manually. Last URL: ${lastUrl || "unknown"}`
  };
}

function getTabSafe(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(tab || null);
    });
  });
}

function buildSummary(jobs) {
  const summary = {
    totalProcessed: jobs.length,
    submitted: 0,
    manualReviewRequired: 0,
    skipped: 0,
    alreadySubmitted: 0,
    dryRunWouldApply: 0
  };

  for (const job of jobs) {
    if (job.status === "submitted") {
      summary.submitted += 1;
      continue;
    }
    if (job.status === "manual_review_required") {
      summary.manualReviewRequired += 1;
      continue;
    }
    if (job.status === "already_submitted") {
      summary.alreadySubmitted += 1;
      continue;
    }
    if (job.status === "dry_run_would_apply") {
      summary.dryRunWouldApply += 1;
      continue;
    }
    summary.skipped += 1;
  }

  return summary;
}

async function mergeJobHistory(jobRecords) {
  const history = (await getStorage(STORAGE_KEYS.JOB_HISTORY)) || {};

  for (const record of jobRecords) {
    if (!record.jobId) {
      continue;
    }

    history[record.jobId] = {
      ...history[record.jobId],
      ...record,
      updatedAt: new Date().toISOString()
    };
  }

  await setStorage(STORAGE_KEYS.JOB_HISTORY, pruneJobHistory(history));
}

function pruneJobHistory(history) {
  const entries = Object.entries(history || {});
  if (entries.length <= MAX_JOB_HISTORY_ENTRIES) {
    return history || {};
  }

  entries.sort((a, b) => {
    const aTime = Date.parse(a[1]?.updatedAt || "") || 0;
    const bTime = Date.parse(b[1]?.updatedAt || "") || 0;
    return bTime - aTime;
  });

  const limited = entries.slice(0, MAX_JOB_HISTORY_ENTRIES);
  return Object.fromEntries(limited);
}

async function recoverStaleRunLock(options = {}) {
  const force = Boolean(options.force);
  const reason = options.reason || null;
  const state = (await getStorage(STORAGE_KEYS.STATE)) || {};
  if (!state.inProgress) {
    return;
  }

  const startedAtMs = state.runStartedAt ? Date.parse(state.runStartedAt) : NaN;
  const hasValidStart = Number.isFinite(startedAtMs);
  const isStale = !hasValidStart || Date.now() - startedAtMs > RUN_STALE_TIMEOUT_MS;

  if (!force && !isStale) {
    return;
  }

  await setStorage(STORAGE_KEYS.STATE, {
    ...state,
    inProgress: false,
    currentRunId: null,
    runStartedAt: null
  });

  await appendLog("warn", "background", "Recovered stale in-progress run lock.", {
    previousRunId: state.currentRunId || null,
    previousRunStartedAt: state.runStartedAt || null,
    recoveryReason: reason || (force ? "forced" : "stale_timeout")
  });
}

async function requestStopAutomation() {
  const state = (await getStorage(STORAGE_KEYS.STATE)) || {};
  const settings = await getSettings();

  await setStorage(STORAGE_KEYS.SETTINGS, {
    ...settings,
    scheduleEnabled: false
  });

  await setStorage(STORAGE_KEYS.STATE, {
    ...state,
    stopRequested: true
  });

  await appendLog("warn", "popup", "Stop requested by user. Scheduler disabled and run will stop safely.", {
    inProgress: Boolean(state.inProgress),
    currentRunId: state.currentRunId || null
  });

  return {
    stopRequested: true,
    inProgress: Boolean(state.inProgress),
    currentRunId: state.currentRunId || null
  };
}

async function clearStopRequest(reason) {
  const state = (await getStorage(STORAGE_KEYS.STATE)) || {};
  if (!state.stopRequested) {
    return;
  }
  await setStorage(STORAGE_KEYS.STATE, {
    ...state,
    stopRequested: false
  });
  await appendLog("info", "background", "Stop request cleared.", { reason: reason || "unknown" });
}

async function isStopRequested() {
  const state = (await getStorage(STORAGE_KEYS.STATE)) || {};
  return Boolean(state.stopRequested);
}

async function getSettings() {
  const saved = (await getStorage(STORAGE_KEYS.SETTINGS)) || {};
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    billing: {
      ...DEFAULT_SETTINGS.billing,
      ...(saved.billing || {})
    },
    subscriptionAuth: {
      ...DEFAULT_SETTINGS.subscriptionAuth,
      ...(saved.subscriptionAuth || {})
    },
    profile: {
      ...DEFAULT_SETTINGS.profile,
      ...(saved.profile || {})
    }
  };
}

async function saveSettings(partial) {
  const current = await getSettings();
  const next = {
    ...current,
    ...partial,
    billing: {
      ...current.billing,
      ...(partial.billing || {})
    },
    subscriptionAuth: {
      ...current.subscriptionAuth,
      ...(partial.subscriptionAuth || {})
    },
    profile: {
      ...current.profile,
      ...(partial.profile || {})
    }
  };

  next.searchUrl = normalizeDiceSearchUrl(next.searchUrl);
  next.maxJobsPerRun = clampNumber(next.maxJobsPerRun, LIMITS.maxJobsPerRun);
  next.maxPaginationPages = clampNumber(next.maxPaginationPages, LIMITS.maxPaginationPages);
  next.maxFormSteps = clampNumber(next.maxFormSteps, LIMITS.maxFormSteps);

  await setStorage(STORAGE_KEYS.SETTINGS, next);
  if (partial.scheduleEnabled === true) {
    await clearStopRequest("settings_schedule_enabled");
  }
  await appendLog("info", "popup", "Settings updated.", {
    scheduleEnabled: next.scheduleEnabled,
    maxJobsPerRun: next.maxJobsPerRun,
    maxPaginationPages: next.maxPaginationPages,
    dryRun: next.dryRun
  });
  return next;
}

async function getStatus() {
  const state = (await getStorage(STORAGE_KEYS.STATE)) || {};
  const settings = await getSettings();
  const logs = (await getStorage(STORAGE_KEYS.LOGS)) || [];

  return {
    state,
    settings,
    logCount: logs.length,
    freeTier: await getFreeTierStatus(),
    subscription: await getSubscriptionStatus(),
    pricing: {
      plans: PLAN_CATALOG
    }
  };
}

async function getLogs() {
  return (await getStorage(STORAGE_KEYS.LOGS)) || [];
}

async function clearLogs() {
  await setStorage(STORAGE_KEYS.LOGS, []);
  await appendLog("info", "popup", "Logs were cleared by user.");
  return { cleared: true };
}

async function appendLog(level, source, message, data = {}, sender = null) {
  const logs = (await getStorage(STORAGE_KEYS.LOGS)) || [];
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    level,
    source,
    message,
    data,
    senderTabId: sender?.tab?.id ?? null
  };

  logs.push(entry);

  if (logs.length > 1500) {
    logs.splice(0, logs.length - 1500);
  }

  await setStorage(STORAGE_KEYS.LOGS, logs);
  return entry;
}

async function pruneOldSlotRuns(slotRuns) {
  const entries = Object.entries(slotRuns)
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .slice(0, 21);

  const compact = {};
  for (const [key, value] of entries) {
    compact[key] = value;
  }

  Object.keys(slotRuns).forEach((key) => {
    delete slotRuns[key];
  });
  Object.assign(slotRuns, compact);
}

async function getOrCreateDailySchedulePlan(dateKey) {
  const allPlans = (await getStorage(STORAGE_KEYS.SCHEDULE_PLANS)) || {};
  if (allPlans[dateKey]?.slots?.length === DAILY_RANDOM_SLOT_COUNT) {
    return allPlans[dateKey];
  }

  const slots = buildDailyRandomSlots();
  const plan = {
    dateKey,
    localTimeZone: getLocalTimeZone(),
    generatedAt: new Date().toISOString(),
    slots
  };
  allPlans[dateKey] = plan;

  pruneOldSchedulePlans(allPlans);
  await setStorage(STORAGE_KEYS.SCHEDULE_PLANS, allPlans);

  await appendLog("info", "scheduler", "Generated daily random schedule.", {
    dateKey,
    localTimeZone: plan.localTimeZone,
    slots: slots.map((slot) => slot.key)
  });

  return plan;
}

function buildDailyRandomSlots() {
  const uniqueMinutes = new Set();
  while (uniqueMinutes.size < DAILY_RANDOM_SLOT_COUNT) {
    uniqueMinutes.add(randomIntInclusive(ACTIVE_MINUTES.start, ACTIVE_MINUTES.end));
  }

  return Array.from(uniqueMinutes)
    .sort((a, b) => a - b)
    .map((minutes, index) => ({
      key: `R${index + 1}-${formatMinutes(minutes)}`,
      minutes
    }));
}

function randomIntInclusive(min, max) {
  const low = Math.ceil(min);
  const high = Math.floor(max);
  return Math.floor(Math.random() * (high - low + 1)) + low;
}

function formatMinutes(totalMinutes) {
  const hour = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  return `${pad2(hour)}:${pad2(minute)}`;
}

function getLocalDateKey(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function getLocalTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
}

function pruneOldSchedulePlans(schedulePlans) {
  const entries = Object.entries(schedulePlans)
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .slice(0, 14);

  const compact = {};
  for (const [key, value] of entries) {
    compact[key] = value;
  }

  Object.keys(schedulePlans).forEach((key) => {
    delete schedulePlans[key];
  });
  Object.assign(schedulePlans, compact);
}

function getDatePartsInTimeZone(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });

  const parts = formatter.formatToParts(date);
  const map = {};
  for (const part of parts) {
    if (part.type !== "literal") {
      map[part.type] = Number(part.value);
    }
  }

  return {
    year: map.year,
    month: map.month,
    day: map.day,
    hour: map.hour,
    minute: map.minute,
    second: map.second
  };
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function getStorage(key) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([key], (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result[key]);
    });
  });
}

function setStorage(key, value) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [key]: value }, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

function createAlarm(name, info) {
  return new Promise((resolve) => {
    chrome.alarms.create(name, info);
    resolve();
  });
}

function queryTabs(queryInfo) {
  return new Promise((resolve, reject) => {
    chrome.tabs.query(queryInfo, (tabs) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(tabs || []);
    });
  });
}

function updateTab(tabId, updateProperties) {
  return new Promise((resolve, reject) => {
    chrome.tabs.update(tabId, updateProperties, (tab) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(tab);
    });
  });
}

function createTab(createProperties) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create(createProperties, (tab) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(tab);
    });
  });
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("Timed out waiting for Dice tab to load."));
    }, timeoutMs);

    const listener = (updatedTabId, info) => {
      if (updatedTabId === tabId && info.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };

    chrome.tabs.onUpdated.addListener(listener);
  });
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      if (response && response.ok === false) {
        reject(new Error(response.error || "Unknown tab response error."));
        return;
      }

      resolve(response);
    });
  });
}

async function sendTabMessageResilient(tabId, message, options = {}) {
  const attempts = Math.max(1, Number(options.attempts || 3));
  const retryDelayMs = Math.max(200, Number(options.retryDelayMs || 700));

  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await sendTabMessage(tabId, message);
    } catch (error) {
      lastError = error;
      const retriable = isMessageChannelClosedError(error) || isNoReceivingEndError(error);
      if (!retriable || attempt >= attempts) {
        throw error;
      }

      await wait(retryDelayMs * attempt);
      await ensureContentScript(tabId);
    }
  }

  throw lastError || new Error("Failed to message tab.");
}

function isNoReceivingEndError(error) {
  const message = String(error?.message || "");
  return /receiving end does not exist/i.test(message);
}

function normalizeDiceSearchUrl(value) {
  const fallback = DEFAULT_SETTINGS.searchUrl;
  const raw = String(value || "").trim();
  if (!raw) {
    return fallback;
  }

  try {
    const parsed = new URL(raw);
    if (!/(\.|^)dice\.com$/i.test(parsed.hostname)) {
      return fallback;
    }
    if (!parsed.pathname.includes("/jobs")) {
      parsed.pathname = "/jobs";
    }
    const parsedPage = Number(parsed.searchParams.get("page") || "1");
    if (Number.isFinite(parsedPage) && parsedPage > 1) {
      parsed.searchParams.delete("page");
    }
    return parsed.href;
  } catch (error) {
    return fallback;
  }
}

function clampNumber(value, rule) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return rule.fallback;
  }
  return Math.max(rule.min, Math.min(rule.max, parsed));
}

async function openSubscriptionCheckout(options = {}) {
  const settings = await ensureSubscriptionLicenseKey();
  const planKey = resolvePlanKey(options.plan || DEFAULT_CHECKOUT_PLAN);
  const plan = PLAN_CATALOG[planKey];
  const url = normalizeHttpUrl(settings.billing?.checkoutUrl);
  if (!url) {
    throw new Error("Checkout URL is not configured.");
  }
  const checkoutUrl = addBillingQuery(url, settings.subscriptionAuth, plan.slug);
  await createTab({ url: checkoutUrl, active: true });
  await appendLog("info", "billing", `Opened ${plan.name} checkout.`, {
    plan: planKey,
    price: plan.priceLabel,
    hasEmail: Boolean(settings.subscriptionAuth?.email),
    hasLicenseKey: Boolean(settings.subscriptionAuth?.licenseKey)
  });
  return { opened: true, url: checkoutUrl };
}

async function openSubscriptionPortal() {
  const settings = await getSettings();
  const subscription = await getSubscriptionStatus();
  const url = normalizeHttpUrl(subscription.customerPortalUrl || settings.billing?.portalUrl);
  if (!url) {
    throw new Error("Customer portal URL is not configured.");
  }
  const portalUrl = addBillingQuery(url, settings.subscriptionAuth);
  await createTab({ url: portalUrl, active: true });
  await appendLog("info", "billing", "Opened billing portal.", {
    plan: subscription.plan,
    status: subscription.status
  });
  return { opened: true, url: portalUrl };
}

async function refreshSubscriptionStatus() {
  const settings = await getSettings();
  const validationUrl = normalizeHttpUrl(settings.billing?.validationUrl);
  const email = String(settings.subscriptionAuth?.email || "").trim();
  const licenseKey = String(settings.subscriptionAuth?.licenseKey || "").trim();

  if (!validationUrl) {
    const state = buildFreeSubscriptionState("validation_url_missing");
    await setStorage(STORAGE_KEYS.SUBSCRIPTION, state);
    return state;
  }

  if (!email || !licenseKey) {
    const state = buildFreeSubscriptionState("missing_credentials");
    await setStorage(STORAGE_KEYS.SUBSCRIPTION, state);
    return state;
  }

  try {
    const response = await fetch(validationUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        email,
        licenseKey,
        extensionName: "NDice Indeed",
        extensionVersion: chrome.runtime.getManifest().version
      })
    });

    if (!response.ok) {
      throw new Error(`Subscription validation failed with HTTP ${response.status}.`);
    }

    const payload = await response.json();
    const state = normalizeSubscriptionPayload(payload);
    await setStorage(STORAGE_KEYS.SUBSCRIPTION, state);
    await appendLog("info", "billing", "Subscription status refreshed.", {
      plan: state.plan,
      status: state.status,
      active: state.active
    });
    return state;
  } catch (error) {
    const current = await getSubscriptionStatus({ skipGraceRefresh: true });
    const fallback = {
      ...current,
      checkedAt: new Date().toISOString(),
      lastError: error.message
    };
    await setStorage(STORAGE_KEYS.SUBSCRIPTION, fallback);
    await appendLog("warn", "billing", "Subscription refresh failed; using cached plan state.", {
      error: error.message,
      cachedPlan: fallback.plan,
      cachedStatus: fallback.status
    });
    return fallback;
  }
}

async function getSubscriptionStatus(options = {}) {
  const saved = (await getStorage(STORAGE_KEYS.SUBSCRIPTION)) || buildFreeSubscriptionState("not_checked");
  const normalized = normalizeSubscriptionPayload(saved);
  if (options.skipGraceRefresh) {
    return normalized;
  }

  if (!normalized.active && normalized.plan !== "free" && normalized.currentPeriodEnd) {
    const periodEndMs = Date.parse(normalized.currentPeriodEnd);
    if (Number.isFinite(periodEndMs) && Date.now() - periodEndMs <= SUBSCRIPTION_GRACE_PERIOD_MS) {
      const plan = PLAN_CATALOG[resolvePlanKey(normalized.plan)];
      return {
        ...normalized,
        status: "grace_period",
        active: true,
        entitlements: {
          ...normalized.entitlements,
          dailyApplicationLimit: plan.dailyApplicationLimit,
          unlimitedApplications: plan.unlimitedApplications
        }
      };
    }
  }

  return normalized;
}

function normalizeSubscriptionPayload(payload = {}) {
  const planKey = resolvePlanKey(payload.plan);
  const plan = PLAN_CATALOG[planKey];
  const status = String(payload.status || (planKey !== "free" ? "active" : "free")).toLowerCase();
  const activeStatuses = new Set(["active", "trialing", "grace_period"]);
  const active = planKey !== "free" && activeStatuses.has(status) && payload.active !== false;
  const effectivePlanKey = active || planKey !== "free" ? planKey : "free";
  const effectivePlan = PLAN_CATALOG[effectivePlanKey];
  const entitlementPlan = active ? effectivePlan : PLAN_CATALOG.free;

  return {
    plan: effectivePlanKey,
    planName: effectivePlan.name,
    status: active ? status : (payload.reason || status || "free"),
    active,
    priceLabel: effectivePlan.priceLabel,
    checkedAt: payload.checkedAt || new Date().toISOString(),
    currentPeriodEnd: payload.currentPeriodEnd || null,
    customerPortalUrl: normalizeHttpUrl(payload.customerPortalUrl) || "",
    lastError: payload.lastError || "",
    entitlements: {
      ...(payload.entitlements || {}),
      dailyApplicationLimit: entitlementPlan.dailyApplicationLimit,
      unlimitedApplications: active && effectivePlan.unlimitedApplications
    }
  };
}

function buildFreeSubscriptionState(reason) {
  return normalizeSubscriptionPayload({
    plan: "free",
    status: "free",
    reason,
    active: false,
    checkedAt: new Date().toISOString()
  });
}

function resolvePlanKey(plan) {
  const raw = String(plan || "").trim().toLowerCase();
  const normalized = raw.replace(/_/g, "-");
  if (normalized === "starter" || normalized === "starter-monthly") {
    return "starter";
  }
  if (normalized === "pro" || normalized === "pro-monthly") {
    return "pro";
  }
  if (normalized === "unlimited" || normalized === "unlimited-monthly") {
    return "unlimited";
  }
  return "free";
}

function getSubscriptionDailyLimit(subscription = {}) {
  if (subscription.entitlements?.unlimitedApplications) {
    return Infinity;
  }
  const explicitLimit = Number(subscription.entitlements?.dailyApplicationLimit);
  if (Number.isFinite(explicitLimit) && explicitLimit > 0) {
    return explicitLimit;
  }
  return PLAN_CATALOG[resolvePlanKey(subscription.plan)].dailyApplicationLimit || FREE_DAILY_APPLICATION_LIMIT;
}

function normalizeHttpUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return "";
    }
    return parsed.href;
  } catch (error) {
    return "";
  }
}

async function ensureSubscriptionLicenseKey() {
  const settings = await getSettings();
  if (settings.subscriptionAuth?.licenseKey) {
    return settings;
  }

  const next = {
    ...settings,
    subscriptionAuth: {
      ...settings.subscriptionAuth,
      licenseKey: generateLicenseKey()
    }
  };
  await setStorage(STORAGE_KEYS.SETTINGS, next);
  return next;
}

function generateLicenseKey() {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .replace(/(.{6})/g, "$1-")
    .replace(/-$/, "")
    .toUpperCase();
}

function addBillingQuery(url, subscriptionAuth = {}, planSlug = "") {
  const parsed = new URL(url);
  const email = String(subscriptionAuth.email || "").trim();
  const licenseKey = String(subscriptionAuth.licenseKey || "").trim();
  if (planSlug) {
    parsed.searchParams.set("plan", planSlug);
  }
  if (email) {
    parsed.searchParams.set("email", email);
  }
  if (licenseKey) {
    parsed.searchParams.set("license_key", licenseKey);
  }
  return parsed.href;
}

async function getDailyUsageForToday() {
  const usage = (await getStorage(STORAGE_KEYS.DAILY_USAGE)) || {};
  const todayKey = getLocalDateKey(new Date());
  const submittedCount = Number(usage?.[todayKey]?.submittedCount || 0);
  return {
    dateKey: todayKey,
    submittedCount: Number.isFinite(submittedCount) ? submittedCount : 0
  };
}

async function incrementDailySubmittedCount(incrementBy = 1) {
  const usage = (await getStorage(STORAGE_KEYS.DAILY_USAGE)) || {};
  const todayKey = getLocalDateKey(new Date());
  const current = Number(usage?.[todayKey]?.submittedCount || 0);
  usage[todayKey] = {
    submittedCount: Math.max(0, current + Math.max(0, Number(incrementBy) || 0)),
    updatedAt: new Date().toISOString()
  };
  pruneOldDailyUsage(usage);
  await setStorage(STORAGE_KEYS.DAILY_USAGE, usage);
}

function pruneOldDailyUsage(usage) {
  const entries = Object.entries(usage || {})
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .slice(0, 35);
  const compact = {};
  for (const [key, value] of entries) {
    compact[key] = value;
  }
  Object.keys(usage || {}).forEach((key) => {
    delete usage[key];
  });
  Object.assign(usage, compact);
}

async function getFreeTierStatus() {
  const today = await getDailyUsageForToday();
  return {
    dailyLimit: FREE_DAILY_APPLICATION_LIMIT,
    submittedToday: today.submittedCount,
    remainingToday: Math.max(0, FREE_DAILY_APPLICATION_LIMIT - today.submittedCount)
  };
}

function executeScript(tabId, files) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript(
      {
        target: { tabId },
        files
      },
      () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve();
      }
    );
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
