const STORAGE_KEYS = {
  SETTINGS: "automationSettings",
  LOGS: "automationLogs",
  JOB_HISTORY: "jobHistory",
  SLOT_RUNS: "slotRuns",
  STATE: "automationState"
};

const ALARM_HEARTBEAT = "automation-heartbeat";
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
      return runAutomation("manual");
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
      currentRunId: null
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
  const state = (await getStorage(STORAGE_KEYS.STATE)) || {};
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
    currentRunId: runId
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

    const listingResponse = await sendTabMessage(sourceTab.id, {
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
        await appendLog("info", "background", "Opening job tab.", { runId, jobId, title, url: job.url });

        jobTab = await createTab({ url: job.url, active: true });
        await waitForTabComplete(jobTab.id, 60000);
        await ensureContentScript(jobTab.id);

        const applyResponse = await sendTabMessage(jobTab.id, {
          type: "dice-apply-single-job",
          payload: {
            jobId,
            profile: settings.profile || {},
            dryRun: Boolean(settings.dryRun),
            maxFormSteps: Number(settings.maxFormSteps || 10)
          }
        });

        const applyResult = applyResponse?.result || {};

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

    await setStorage(STORAGE_KEYS.STATE, {
      inProgress: false,
      lastRunAt: new Date().toISOString(),
      lastRunResult: runResult,
      currentRunId: null
    });

    return { runId, runResult };
  } catch (error) {
    await appendLog("error", "background", "Automation run failed.", {
      runId,
      trigger,
      error: error.message
    });

    await setStorage(STORAGE_KEYS.STATE, {
      inProgress: false,
      lastRunAt: new Date().toISOString(),
      lastRunResult: { status: "error", error: error.message },
      currentRunId: null
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
