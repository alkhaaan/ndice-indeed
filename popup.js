const ids = [
  "scheduleEnabled",
  "searchUrl",
  "maxJobsPerRun",
  "maxPaginationPages",
  "maxFormSteps",
  "dryRun",
  "fullName",
  "email",
  "phone",
  "city",
  "linkedin",
  "website",
  "salaryExpectation",
  "workAuthorization"
];

const elements = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
const feedback = document.getElementById("feedback");
const statusText = document.getElementById("statusText");
const LIMITS = {
  maxJobsPerRun: { min: 1, max: 100, fallback: 15 },
  maxPaginationPages: { min: 1, max: 25, fallback: 5 },
  maxFormSteps: { min: 1, max: 30, fallback: 10 }
};

document.getElementById("saveBtn").addEventListener("click", save);
document.getElementById("runNowBtn").addEventListener("click", runNow);
document.getElementById("stopBtn").addEventListener("click", stopAutomation);
document.getElementById("resumeBtn").addEventListener("click", resumeScheduler);
document.getElementById("openLogsBtn").addEventListener("click", () => chrome.runtime.openOptionsPage());
document.getElementById("clearLogsBtn").addEventListener("click", clearLogs);
document.getElementById("resetSubmittedHistoryBtn").addEventListener("click", resetSubmittedHistory);

document.addEventListener("DOMContentLoaded", async () => {
  await loadSettings();
  await loadStatus();
});

async function loadSettings() {
  const response = await sendMessage({ type: "automation-get-settings" });
  const settings = response.result;

  elements.scheduleEnabled.checked = Boolean(settings.scheduleEnabled);
  elements.searchUrl.value = settings.searchUrl || "";
  elements.maxJobsPerRun.value = clampNumber(settings.maxJobsPerRun, LIMITS.maxJobsPerRun);
  elements.maxPaginationPages.value = clampNumber(settings.maxPaginationPages, LIMITS.maxPaginationPages);
  elements.maxFormSteps.value = clampNumber(settings.maxFormSteps, LIMITS.maxFormSteps);
  elements.dryRun.checked = Boolean(settings.dryRun);

  elements.fullName.value = settings.profile?.fullName || "";
  elements.email.value = settings.profile?.email || "";
  elements.phone.value = settings.profile?.phone || "";
  elements.city.value = settings.profile?.city || "";
  elements.linkedin.value = settings.profile?.linkedin || "";
  elements.website.value = settings.profile?.website || "";
  elements.salaryExpectation.value = settings.profile?.salaryExpectation || "";
  elements.workAuthorization.value = settings.profile?.workAuthorization || "";
}

async function loadStatus() {
  const response = await sendMessage({ type: "automation-get-status" });
  const state = response.result.state || {};
  const logCount = response.result.logCount || 0;

  const parts = [];
  parts.push(`In progress: ${state.inProgress ? "yes" : "no"}`);
  parts.push(`Stop requested: ${state.stopRequested ? "yes" : "no"}`);
  if (state.lastRunAt) {
    parts.push(`Last run: ${new Date(state.lastRunAt).toLocaleString()}`);
  }
  if (state.lastRunResult?.summary) {
    const s = state.lastRunResult.summary;
    parts.push(`Last summary - submitted: ${s.submitted}, manual: ${s.manualReviewRequired}, skipped: ${s.skipped}`);
  }
  parts.push(`Logs: ${logCount}`);

  statusText.textContent = parts.join(" | ");
}

async function save() {
  const maxJobsPerRun = clampNumber(elements.maxJobsPerRun.value, LIMITS.maxJobsPerRun);
  const maxPaginationPages = clampNumber(elements.maxPaginationPages.value, LIMITS.maxPaginationPages);
  const maxFormSteps = clampNumber(elements.maxFormSteps.value, LIMITS.maxFormSteps);

  elements.maxJobsPerRun.value = maxJobsPerRun;
  elements.maxPaginationPages.value = maxPaginationPages;
  elements.maxFormSteps.value = maxFormSteps;

  const payload = {
    scheduleEnabled: elements.scheduleEnabled.checked,
    searchUrl: elements.searchUrl.value.trim(),
    maxJobsPerRun,
    maxPaginationPages,
    maxFormSteps,
    dryRun: elements.dryRun.checked,
    profile: {
      fullName: elements.fullName.value.trim(),
      email: elements.email.value.trim(),
      phone: elements.phone.value.trim(),
      city: elements.city.value.trim(),
      linkedin: elements.linkedin.value.trim(),
      website: elements.website.value.trim(),
      salaryExpectation: elements.salaryExpectation.value.trim(),
      workAuthorization: elements.workAuthorization.value.trim()
    }
  };

  await sendMessage({
    type: "automation-save-settings",
    payload
  });

  feedback.textContent = "Settings saved.";
  await loadStatus();
}

async function runNow() {
  feedback.textContent = "Running automation...";
  const response = await sendMessage({ type: "automation-run-now" });
  if (response.result?.skipped) {
    feedback.textContent = `Run skipped: ${response.result.reason}`;
  } else {
    feedback.textContent = "Run started. Check logs for details.";
  }
  await loadStatus();
}

async function clearLogs() {
  await sendMessage({ type: "automation-clear-logs" });
  feedback.textContent = "Logs cleared.";
  await loadStatus();
}

async function resetSubmittedHistory() {
  const response = await sendMessage({ type: "automation-reset-submitted-history" });
  const removed = Number(response?.result?.removed || 0);
  feedback.textContent = `Reset submitted history entries: ${removed}.`;
  await loadStatus();
}

async function stopAutomation() {
  const response = await sendMessage({ type: "automation-stop" });
  const inProgress = response.result?.inProgress ? "Current run will stop after this job." : "No run is active.";
  feedback.textContent = `Stop requested. Scheduler disabled. ${inProgress}`;
  elements.scheduleEnabled.checked = false;
  await loadStatus();
}

async function resumeScheduler() {
  const payload = {
    scheduleEnabled: true
  };
  await sendMessage({
    type: "automation-save-settings",
    payload
  });
  feedback.textContent = "Scheduler resumed.";
  await loadStatus();
}

function sendMessage(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "Unknown extension error."));
        return;
      }
      resolve(response);
    });
  });
}

function clampNumber(value, rule) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return rule.fallback;
  }
  return Math.max(rule.min, Math.min(rule.max, parsed));
}
