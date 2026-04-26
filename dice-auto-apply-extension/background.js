const STORAGE_KEYS = {
  SETTINGS: "automationSettings",
  LOGS: "automationLogs",
  JOB_HISTORY: "jobHistory",
  SLOT_RUNS: "slotRuns",
  STATE: "automationState"
};

const ALARM_HEARTBEAT = "automation-heartbeat";
const RUN_STALE_TIMEOUT_MS = 20 * 60 * 1000;
const SCHEDULE_SLOTS_ET = [
  { key: "09:00", minutes: 9 * 60 },
  { key: "13:00", minutes: 13 * 60 },
  { key: "18:00", minutes: 18 * 60 }
];

const DEFAULT_SETTINGS = {
  scheduleEnabled: true,
  searchUrl: "https://www.dice.com/jobs?q=&filters.postedDate=ONE&sort=DATE",
  maxJobsPerRun: 15,
  scheduleWindowMinutes: 12,
  maxFormSteps: 10,
  dryRun: false,
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
  await recoverStaleRunLock();
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
    case "automation-get-status":
      return getStatus();
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

  const nowEt = getDatePartsInTimeZone(new Date(), "America/New_York");
  const minutesNowEt = nowEt.hour * 60 + nowEt.minute;
  const dateKey = `${nowEt.year}-${pad2(nowEt.month)}-${pad2(nowEt.day)}`;

  for (const slot of SCHEDULE_SLOTS_ET) {
    const withinWindow = minutesNowEt >= slot.minutes && minutesNowEt <= slot.minutes + settings.scheduleWindowMinutes;
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

    await appendLog("info", "scheduler", `Scheduled run triggered for ET slot ${slot.key}.`, {
      dateKey,
      minutesNowEt
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
    maxJobsPerRun: settings.maxJobsPerRun,
    searchUrl: settings.searchUrl
  });

  try {
    const sourceTab = await resolveSourceTab(trigger, settings.searchUrl);
    await ensureContentScript(sourceTab.id);

    const listingResponse = await sendTabMessageResilient(sourceTab.id, {
      type: "dice-collect-jobs",
      payload: {
        maxJobsPerRun: Number(settings.maxJobsPerRun || 15),
        history
      }
    });

    const discoveredJobs = listingResponse?.result?.jobs || [];

    await appendLog("info", "background", "Collected jobs from listing page.", {
      runId,
      sourceTabId: sourceTab.id,
      collected: discoveredJobs.length
    });

    const jobs = [];

    for (const job of discoveredJobs) {
      const jobId = job.jobId || `job-${Math.random().toString(36).slice(2, 9)}`;
      const title = job.title || "Unknown title";

      if (history[jobId]?.status === "submitted") {
        jobs.push({ jobId, title, status: "already_submitted", skipped: true });
        continue;
      }
      if (history[jobId]?.status === "already_submitted") {
        jobs.push({ jobId, title, status: "already_submitted", skipped: true });
        continue;
      }
      if (job.alreadyApplied) {
        jobs.push({ jobId, title, status: "already_submitted", skipped: true, details: "Skipped because listing indicates already applied." });
        continue;
      }

      if (!job.easyApply) {
        jobs.push({ jobId, title, status: "not_easy_apply", skipped: true, url: job.url || null });
        continue;
      }

      if (!job.url) {
        jobs.push({ jobId, title, status: "missing_job_url", skipped: true });
        continue;
      }

      let jobTab = null;
      try {
        if (await isStopRequested()) {
          await appendLog("warn", "background", "Run stopping by user request before opening next job tab.", {
            runId,
            jobId
          });
          break;
        }
        await appendLog("info", "background", "Opening job tab.", { runId, jobId, title, url: job.url });

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
              maxFormSteps: Number(settings.maxFormSteps || 10)
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
            maxFormSteps: Number(settings.maxFormSteps || 10)
          });
        }

        jobs.push({
          jobId,
          title: applyResult.title || title,
          company: applyResult.company || job.company || "",
          status: applyResult.status || "unknown",
          details: applyResult.details || ""
        });

        await appendLog(
          applyResult.status === "submitted" ? "info" : "warn",
          "background",
          "Job tab finished.",
          {
            runId,
            jobId,
            title: applyResult.title || title,
            status: applyResult.status || "unknown",
            details: applyResult.details || ""
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
          error: error.message
        });
      } finally {
        if (jobTab?.id) {
          await safeCloseTab(jobTab.id);
          await appendLog("info", "background", "Closed job tab.", { runId, jobId, tabId: jobTab.id });
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
  return /message channel closed before a response was received/i.test(message);
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

  await setStorage(STORAGE_KEYS.JOB_HISTORY, history);
}

async function recoverStaleRunLock() {
  const state = (await getStorage(STORAGE_KEYS.STATE)) || {};
  if (!state.inProgress) {
    return;
  }

  const startedAtMs = state.runStartedAt ? Date.parse(state.runStartedAt) : NaN;
  const hasValidStart = Number.isFinite(startedAtMs);
  const isStale = !hasValidStart || Date.now() - startedAtMs > RUN_STALE_TIMEOUT_MS;

  if (!isStale) {
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
    previousRunStartedAt: state.runStartedAt || null
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
    profile: {
      ...current.profile,
      ...(partial.profile || {})
    }
  };

  await setStorage(STORAGE_KEYS.SETTINGS, next);
  if (partial.scheduleEnabled === true) {
    await clearStopRequest("settings_schedule_enabled");
  }
  await appendLog("info", "popup", "Settings updated.", {
    scheduleEnabled: next.scheduleEnabled,
    maxJobsPerRun: next.maxJobsPerRun,
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
    logCount: logs.length
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
