let isRunning = false;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "indeed-ping") {
    sendResponse({ ok: true, result: "pong" });
    return;
  }

  if (message?.type === "indeed-run-automation") {
    runIndeedAutomation(message.payload)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

async function runIndeedAutomation(payload) {
  if (isRunning) {
    throw new Error("Indeed automation is already running on this tab.");
  }

  isRunning = true;
  const startedAt = new Date().toISOString();
  const jobs = [];

  try {
    const settings = payload.settings || {};
    const history = payload.history || {};

    if (!location.hostname.includes("indeed.com")) {
      throw new Error("Active tab is not on indeed.com.");
    }

    if (!location.pathname.startsWith("/jobs")) {
      throw new Error("Automation expected to run on Indeed search results page (/jobs).");
    }

    await log("info", "run", "Indeed run started.", {
      runId: payload.runId,
      trigger: payload.trigger,
      dryRun: settings.dryRun,
      url: location.href
    });

    await wait(1200);
    const cards = collectJobCards();
    await log("info", "discover", "Job cards discovered.", { found: cards.length });

    const maxJobs = Math.max(1, Number(settings.maxJobsPerRun || 10));

    for (let i = 0; i < cards.length && jobs.length < maxJobs; i += 1) {
      const card = cards[i];
      const jobId = getJobId(card);

      if (!jobId) {
        continue;
      }

      if (history[jobId]?.status === "submitted") {
        jobs.push({
          jobId,
          status: "already_submitted",
          title: getCardTitle(card),
          skipped: true
        });
        continue;
      }

      await openJobCard(card);
      await wait(900);

      const title = getJobTitleFromDetail() || getCardTitle(card);
      const company = getCompanyFromDetail();

      const applyButton = findApplyButton();
      if (!applyButton) {
        jobs.push({
          jobId,
          status: "non_easy_apply_or_unavailable",
          title,
          company
        });

        await log("info", "job", "Skipped job because no easy apply button was found.", {
          jobId,
          title,
          company
        });
        continue;
      }

      if (settings.dryRun) {
        jobs.push({
          jobId,
          status: "dry_run_would_apply",
          title,
          company
        });

        await log("info", "job", "Dry run: job identified for application.", {
          jobId,
          title,
          company
        });
        continue;
      }

      const applyResult = await applyToCurrentJob({
        applyButton,
        maxFormSteps: Number(settings.maxFormSteps || 10),
        profile: settings.profile || {}
      });

      jobs.push({
        jobId,
        title,
        company,
        status: applyResult.status,
        details: applyResult.details
      });

      await log(applyResult.status === "submitted" ? "info" : "warn", "job", "Application attempt finished.", {
        jobId,
        title,
        company,
        ...applyResult
      });

      await wait(700);
    }

    const summary = buildSummary(jobs);
    await log("info", "run", "Indeed run completed.", { summary, processed: jobs.length });

    return {
      status: "completed",
      startedAt,
      endedAt: new Date().toISOString(),
      summary,
      jobs
    };
  } finally {
    isRunning = false;
  }
}

function collectJobCards() {
  const seen = new Set();
  const cards = [];

  const anchors = Array.from(document.querySelectorAll("a.jcs-JobTitle[data-jk], a.jcs-JobTitle[href*='jk=']"));
  for (const anchor of anchors) {
    const container = anchor.closest(".job_seen_beacon, li, [data-jk]") || anchor;
    const key = getJobId(container) || getJobId(anchor);
    if (key && !seen.has(key)) {
      seen.add(key);
      cards.push(container);
    }
  }

  return cards;
}

function getJobId(element) {
  if (!element) {
    return null;
  }

  const dataJk = element.getAttribute?.("data-jk") || element.dataset?.jk;
  if (dataJk) {
    return dataJk;
  }

  const anchor = element.matches?.("a") ? element : element.querySelector?.("a[href*='jk=']");
  const href = anchor?.getAttribute("href") || "";
  const match = href.match(/[?&]jk=([^&]+)/i);
  return match ? decodeURIComponent(match[1]) : null;
}

function getCardTitle(card) {
  const anchor = card.querySelector?.("a.jcs-JobTitle") || card.querySelector?.("a");
  return normalizeText(anchor?.textContent || "Unknown title");
}

async function openJobCard(card) {
  const clickable = card.querySelector?.("a.jcs-JobTitle") || card.querySelector?.("a[href*='jk=']") || card;
  clickable.scrollIntoView({ behavior: "smooth", block: "center" });
  await wait(200);
  clickable.click();
}

function getJobTitleFromDetail() {
  const selectors = [
    "h1.jobsearch-JobInfoHeader-title",
    "h2.jobsearch-JobInfoHeader-title"
  ];

  for (const selector of selectors) {
    const node = document.querySelector(selector);
    if (node) {
      return normalizeText(node.textContent);
    }
  }

  return "";
}

function getCompanyFromDetail() {
  const selectors = [
    "div.jobsearch-InlineCompanyRating div:first-child",
    "div.jobsearch-CompanyInfoWithoutHeaderImage div:first-child"
  ];

  for (const selector of selectors) {
    const node = document.querySelector(selector);
    if (node) {
      return normalizeText(node.textContent);
    }
  }

  return "";
}

function findApplyButton() {
  const buttons = Array.from(document.querySelectorAll("button, a[role='button']"));
  return buttons.find((button) => {
    if (!isElementVisible(button)) {
      return false;
    }
    const text = normalizeText(button.textContent || "").toLowerCase();
    return /^(apply now|easily apply|easy apply)/i.test(text) || /easy apply|apply now/.test(text);
  }) || null;
}

async function applyToCurrentJob({ applyButton, maxFormSteps, profile }) {
  applyButton.click();
  await wait(1200);

  for (let step = 0; step < maxFormSteps; step += 1) {
    fillKnownFields(profile);

    if (hasFileUploadInput()) {
      const maybeContinue = findVisibleButtonByRegex(/continue|next|review/i);
      if (maybeContinue) {
        maybeContinue.click();
        await wait(900);
      } else {
        return {
          status: "manual_review_required",
          details: "File upload or custom attachment is required."
        };
      }
    }

    const submitButton = findVisibleButtonByRegex(/submit|apply now|finish|send application/i);
    if (submitButton) {
      submitButton.click();
      await wait(1400);

      if (!isApplyModalOpen()) {
        return {
          status: "submitted",
          details: "Submission click completed and modal closed."
        };
      }
    }

    const nextButton = findVisibleButtonByRegex(/continue|next|review|save and continue/i);
    if (nextButton) {
      nextButton.click();
      await wait(1000);
      continue;
    }

    if (!isApplyModalOpen()) {
      return {
        status: "submitted",
        details: "Modal closed after navigation, submission likely completed."
      };
    }

    return {
      status: "manual_review_required",
      details: "No deterministic next/submit button found in apply flow."
    };
  }

  return {
    status: "manual_review_required",
    details: "Maximum form step limit reached."
  };
}

function fillKnownFields(profile) {
  const inputs = Array.from(document.querySelectorAll("input, textarea, select"));

  for (const input of inputs) {
    if (!isElementVisible(input) || input.disabled || input.readOnly) {
      continue;
    }

    if (input.tagName.toLowerCase() === "select") {
      continue;
    }

    const type = (input.getAttribute("type") || "text").toLowerCase();
    if (["file", "hidden", "submit", "button", "radio", "checkbox"].includes(type)) {
      continue;
    }

    const existingValue = input.value?.trim() || "";
    if (existingValue) {
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
    const closestLabel = input.closest("label");
    labelText = normalizeText(closestLabel?.textContent || "");
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
  const buttons = Array.from(document.querySelectorAll("button, a[role='button']"));
  return buttons.find((button) => {
    if (!isElementVisible(button)) {
      return false;
    }
    const text = normalizeText(button.textContent || "");
    return regex.test(text);
  }) || null;
}

function isApplyModalOpen() {
  const modals = Array.from(document.querySelectorAll("[role='dialog'], .ia-IndeedApplyModal"));
  return modals.some((modal) => isElementVisible(modal));
}

function hasFileUploadInput() {
  const fileInput = document.querySelector("input[type='file']");
  return Boolean(fileInput && isElementVisible(fileInput));
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
    // Ignore logging failures so they do not block automation.
  }
}
