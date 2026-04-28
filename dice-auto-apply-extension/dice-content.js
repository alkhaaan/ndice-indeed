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

  if (message?.type === "dice-probe-apply-outcome") {
    probeApplyOutcome()
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "dice-complete-wizard") {
    completeDiceWizard(message.payload)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

async function collectJobsFromSearch(payload) {
  const maxJobsPerRun = Math.max(1, Number(payload?.maxJobsPerRun || 15));
  const requestedPages = Number(payload?.maxPaginationPages);
  const maxPaginationPages = Math.max(
    1,
    Math.min(25, Number.isFinite(requestedPages) && requestedPages > 0 ? requestedPages : 1)
  );
  const history = payload?.history || {};

  if (!location.hostname.includes("dice.com")) {
    throw new Error("Job collection must run on dice.com.");
  }

  const jobs = [];
  const seenKeys = new Set();
  const pageUrls = [];
  let pagesVisited = 0;
  let pageAdvanceCount = 0;
  let totalCardsScanned = 0;
  let stopReason = "exhausted";

  for (let pageIndex = 0; pageIndex < maxPaginationPages; pageIndex += 1) {
    await wait(900);
    pagesVisited += 1;
    pageUrls.push(location.href);

    const cards = collectJobCards();
    totalCardsScanned += cards.length;

    for (const card of cards) {
      if (jobs.length >= maxJobsPerRun) {
        stopReason = "max_jobs_reached";
        break;
      }

      const item = extractJobFromCard(card);
      if (!item) {
        continue;
      }

      const dedupeKey = `${item.jobId || ""}|${item.url || ""}`;
      if (seenKeys.has(dedupeKey)) {
        continue;
      }
      seenKeys.add(dedupeKey);

      if (history[item.jobId]?.status === "submitted") {
        item.previousStatus = "already_submitted";
      }
      if (history[item.jobId]?.status === "already_submitted") {
        item.previousStatus = "already_submitted";
      }

      jobs.push(item);
    }

    if (jobs.length >= maxJobsPerRun) {
      break;
    }

    if (pageIndex >= maxPaginationPages - 1) {
      stopReason = "max_pages_reached";
      break;
    }

    const advanced = await goToNextResultsPage();
    if (!advanced.advanced) {
      stopReason = advanced.reason || "next_page_unavailable";
      break;
    }

    pageAdvanceCount += 1;
  }

  await log("info", "discover", "Collected jobs from search page.", {
    foundCards: totalCardsScanned,
    returnedJobs: jobs.length,
    pagesVisited,
    pageAdvanceCount,
    stopReason,
    pageUrls,
    url: location.href
  });

  return { jobs };
}

async function goToNextResultsPage() {
  const beforeUrl = location.href;
  const beforeFingerprint = getResultsFingerprint();
  const pagination = getResultsPaginationState();

  if (pagination.current && pagination.total && pagination.current >= pagination.total) {
    return { advanced: false, reason: "last_page_reached" };
  }

  const nextControl = findNextResultsControl();
  if (nextControl) {
    nextControl.click();
    const changed = await waitForResultsPageChange(beforeUrl, beforeFingerprint, 10000);
    if (changed) {
      return { advanced: true, reason: "next_control_clicked" };
    }
  }

  const nextUrl = buildNextPageUrl(beforeUrl);
  if (nextUrl && nextUrl !== beforeUrl) {
    location.assign(nextUrl);
    const changed = await waitForResultsPageChange(beforeUrl, beforeFingerprint, 10000);
    if (changed) {
      return { advanced: true, reason: "url_page_advanced" };
    }
  }

  return { advanced: false, reason: "next_page_not_detected" };
}

function getResultsPaginationState() {
  const containers = Array.from(
    document.querySelectorAll(
      "nav[aria-label*='pagination' i], [class*='pagination'], [data-testid*='pagination'], [data-cy*='pagination']"
    )
  );

  for (const container of containers) {
    const text = normalizeText(container.textContent || "");
    const match = text.match(/(\d+)\s*of\s*(\d+)/i);
    if (!match) {
      continue;
    }
    return {
      current: Number(match[1]),
      total: Number(match[2])
    };
  }

  const url = new URL(location.href);
  const page = Number(url.searchParams.get("page") || "1");
  return {
    current: Number.isFinite(page) && page > 0 ? page : null,
    total: null
  };
}

function getResultsFingerprint() {
  const cards = collectJobCards().slice(0, 6);
  const signatures = cards.map((card) => {
    const jobId = getJobId(card) || "";
    const anchor = card.querySelector("a[href*='/job-detail/'], a[href*='jobId='], a");
    const href = normalizeText(anchor?.getAttribute("href") || anchor?.href || "");
    const title = getCardTitle(card);
    return `${jobId}|${href}|${title}`;
  });
  return signatures.join("::");
}

function findNextResultsControl() {
  const paginationContainers = Array.from(
    document.querySelectorAll(
      "nav[aria-label*='pagination' i], [class*='pagination'], [data-testid*='pagination'], [data-cy*='pagination']"
    )
  );

  const scopedCandidates = paginationContainers.flatMap((container) =>
    Array.from(container.querySelectorAll("button, a[role='button'], a, input[type='button']"))
  );
  const fallbackCandidates = Array.from(
    document.querySelectorAll("button[aria-label*='next' i], a[aria-label*='next' i], button[title*='next' i], a[title*='next' i]")
  );
  const candidates = [...scopedCandidates, ...fallbackCandidates];

  for (const element of candidates) {
    if (!isElementVisible(element)) {
      continue;
    }
    if (element.disabled || element.getAttribute("aria-disabled") === "true") {
      continue;
    }

    const text = normalizeText(element.textContent || element.value || "").toLowerCase();
    const aria = normalizeText(element.getAttribute("aria-label") || "").toLowerCase();
    const title = normalizeText(element.getAttribute("title") || "").toLowerCase();
    const classes = normalizeText(element.className || "").toLowerCase();
    const descriptor = `${text} ${aria} ${title} ${classes}`;

    if (!/next|forward|arrow-right|chevron-right|page-right|go to next/.test(descriptor) && ![">", "›", "→"].includes(text)) {
      continue;
    }
    if (/last|first|previous|prev|back|double/.test(descriptor)) {
      continue;
    }
    if (text === ">>" || text === "»") {
      continue;
    }

    return element;
  }

  return null;
}

async function waitForResultsPageChange(beforeUrl, beforeFingerprint, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await wait(300);
    const urlChanged = location.href !== beforeUrl;
    const fingerprint = getResultsFingerprint();
    const cardsPresent = collectJobCards().length > 0;
    if (urlChanged && cardsPresent) {
      return true;
    }
    if (fingerprint && beforeFingerprint && fingerprint !== beforeFingerprint) {
      return true;
    }
  }
  return false;
}

function buildNextPageUrl(currentUrl) {
  try {
    const url = new URL(currentUrl);
    const currentPage = Number(url.searchParams.get("page") || "1");
    const nextPage = Number.isFinite(currentPage) && currentPage > 0 ? currentPage + 1 : 2;
    url.searchParams.set("page", String(nextPage));
    return url.href;
  } catch (error) {
    return null;
  }
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

    if (isAlreadyAppliedPage()) {
      return {
        jobId,
        title,
        company,
        status: "already_submitted",
        details: "Job appears already applied based on page signals."
      };
    }

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

async function probeApplyOutcome() {
  const url = location.href;
  const title = getDetailTitle() || normalizeText(document.title || "") || "Unknown title";
  const bodyText = normalizeText(document.body?.innerText || "").toLowerCase();

  const submittedPatterns = [
    "application submitted",
    "thank you for applying",
    "application received",
    "you have applied",
    "successfully applied"
  ];
  const alreadyPatterns = [
    "already applied",
    "withdraw application",
    "application already submitted"
  ];

  const matchedSignals = submittedPatterns.filter((pattern) => bodyText.includes(pattern));
  const alreadySignals = alreadyPatterns.filter((pattern) => bodyText.includes(pattern));
  const urlSignals = [];
  if (/application-submitted|apply-confirmation|thank/.test(url.toLowerCase())) {
    urlSignals.push("url_confirmation_pattern");
  }
  if (/already-applied|application-history/.test(url.toLowerCase())) {
    urlSignals.push("url_already_applied_pattern");
  }

  const alreadyApplied = alreadySignals.length > 0 || urlSignals.includes("url_already_applied_pattern");
  const submitted = matchedSignals.length > 0 || urlSignals.includes("url_confirmation_pattern");
  const status = alreadyApplied ? "already_submitted" : submitted ? "submitted" : "unknown";
  return {
    status,
    title,
    evidence: {
      url,
      matchedSignals,
      alreadySignals,
      urlSignals
    }
  };
}

async function completeDiceWizard(payload) {
  const maxFormSteps = Math.max(1, Number(payload?.maxFormSteps || 12));
  const profile = payload?.profile || {};

  await waitForPageReady(12000);

  for (let step = 0; step < maxFormSteps; step += 1) {
    if (isAlreadyAppliedPage()) {
      return {
        status: "already_submitted",
        details: "Wizard indicates this job was already applied."
      };
    }

    if (isSubmissionConfirmationPage()) {
      return {
        status: "submitted",
        details: "Wizard completion signals detected."
      };
    }

    fillKnownFields(profile);

    if (hasFileUploadInput()) {
      const continueBtn = findWizardButtonByRegex(/continue|next|review|skip/i);
      if (continueBtn) {
        continueBtn.click();
        await wait(1200);
        continue;
      }

      return {
        status: "manual_review_required",
        details: "Wizard requires file upload or attachment."
      };
    }

    const submitBtn = findWizardButtonByRegex(/submit|finish|complete|send|apply now|apply/i);
    if (submitBtn) {
      submitBtn.click();
      await wait(1800);
      if (isSubmissionConfirmationPage() || !isApplyModalOpen()) {
        return {
          status: "submitted",
          details: "Submit action completed from wizard final step."
        };
      }
      return {
        status: "manual_review_required",
        details: "Submit was attempted but confirmation was not detected."
      };
    }

    const nextBtn = findWizardButtonByRegex(/continue|next|review|save and continue|proceed/i);
    if (nextBtn) {
      nextBtn.click();
      await wait(1300);
      continue;
    }

    const visualFlow = await runVisualFlowFallback({ profile, maxAttempts: 2 });
    if (visualFlow.advanced) {
      await wait(1200);
      continue;
    }
    if (visualFlow.status === "submitted" || visualFlow.status === "already_submitted") {
      return visualFlow;
    }
    if (visualFlow.status === "manual_review_required") {
      return visualFlow;
    }

    if (isSubmissionConfirmationPage()) {
      return {
        status: "submitted",
        details: "Confirmation detected after wizard navigation."
      };
    }

    return {
      status: "manual_review_required",
      details: "Wizard step has no deterministic next/submit action."
    };
  }

  return {
    status: "manual_review_required",
    details: "Wizard max step limit reached before confirmation."
  };
}

function collectJobCards() {
  const selectors = [
    "[data-cy='card-container']",
    "[id^='position-card-']",
    "[data-testid*='job-card']",
    "[data-testid*='search-result']",
    "li[data-jobid]",
    "article[data-jobid]",
    ".search-card",
    ".job-card"
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
    const anchors = Array.from(
      document.querySelectorAll("a[href*='/job-detail/'], a[href*='/jobs/detail/'], a[href*='jobId=']")
    );
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
    card.querySelector("a[href*='/jobs/detail/']") ||
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
  const isJobUrl = /\/job-detail\/|\/jobs\/detail\/|[?&]jobId=/i.test(url);
  if (!isJobUrl) {
    return null;
  }
  const jobId = getJobId(card) || getJobIdFromHref(url) || getJobIdFromText(card) || `unknown-${Math.random().toString(36).slice(2, 8)}`;

  return {
    jobId,
    title: getCardTitle(card),
    company: getCardCompany(card),
    url,
    easyApply: looksEasyApply(card),
    alreadyApplied: isAlreadyAppliedCard(card)
  };
}

function getCardTitle(card) {
  const node =
    card.querySelector("a[data-cy='card-title-link']") ||
    card.querySelector("[data-testid='job-title']") ||
    card.querySelector("h5") ||
    card.querySelector("h3") ||
    card.querySelector("a[href*='/job-detail/']") ||
    card.querySelector("a[href*='/jobs/detail/']") ||
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

  const anchor =
    card.querySelector("a[href*='/job-detail/']") ||
    card.querySelector("a[href*='/jobs/detail/']") ||
    card.querySelector("a[href*='jobId=']");
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

  const altDetailMatch = href.match(/\/jobs\/detail\/([^/?#]+)/i);
  if (altDetailMatch) {
    return decodeURIComponent(altDetailMatch[1]);
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
  return /easy apply|apply now|quick apply|1-click apply|instant apply/.test(text);
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
    if (isAlreadyAppliedPage()) {
      return {
        status: "already_submitted",
        details: "Job appears already applied."
      };
    }

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
      await wait(1500);
      if (isSubmissionConfirmationPage() || !isApplyModalOpen()) {
        return {
          status: "submitted",
          details: "Submit action completed and flow closed."
        };
      }
      return {
        status: "manual_review_required",
        details: "Submit was attempted but confirmation was not detected."
      };
    }

    const nextBtn = findVisibleButtonByRegex(/continue|next|review|save and continue/i);
    if (nextBtn) {
      nextBtn.click();
      await wait(1000);
      continue;
    }

    const visualFlow = await runVisualFlowFallback({ profile, maxAttempts: 2 });
    if (visualFlow.advanced) {
      await wait(900);
      continue;
    }
    if (visualFlow.status === "submitted" || visualFlow.status === "already_submitted") {
      return visualFlow;
    }
    if (visualFlow.status === "manual_review_required") {
      return visualFlow;
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
  fillChoiceFields(profile);
  fillSelectFields(profile);

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
    if (isSensitiveDiversityQuestion(context)) {
      continue;
    }

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

function fillSelectFields(profile) {
  const selects = Array.from(document.querySelectorAll("select"));
  for (const select of selects) {
    if (!isElementVisible(select) || select.disabled) {
      continue;
    }
    if (select.value && select.value.trim()) {
      continue;
    }

    const context = getFieldContext(select);
    if (isSensitiveDiversityQuestion(context)) {
      continue;
    }

    const answer = resolveFieldValue(context, profile);
    if (!answer) {
      continue;
    }

    const options = Array.from(select.options || []);
    const matched = options.find((opt) => {
      const label = normalizeText(opt.textContent || "").toLowerCase();
      const value = normalizeText(opt.value || "").toLowerCase();
      const needle = normalizeText(answer).toLowerCase();
      if (!needle) {
        return false;
      }
      return label === needle || value === needle || label.includes(needle) || value.includes(needle);
    }) || matchYesNoOption(options, answer);

    if (!matched) {
      continue;
    }

    select.value = matched.value;
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

function fillChoiceFields(profile) {
  const radios = Array.from(document.querySelectorAll("input[type='radio']"));
  const byName = new Map();

  for (const radio of radios) {
    if (!isElementVisible(radio) || radio.disabled) {
      continue;
    }
    const name = radio.name || radio.id || `anon-${Math.random().toString(36).slice(2, 8)}`;
    if (!byName.has(name)) {
      byName.set(name, []);
    }
    byName.get(name).push(radio);
  }

  for (const group of byName.values()) {
    if (group.some((r) => r.checked)) {
      continue;
    }
    const context = getFieldContext(group[0]);
    if (isSensitiveDiversityQuestion(context)) {
      continue;
    }

    const answer = resolveFieldValue(context, profile);
    if (!answer) {
      continue;
    }

    const matched = group.find((radio) => {
      const label = getChoiceLabel(radio).toLowerCase();
      const needle = normalizeText(answer).toLowerCase();
      return label === needle || label.includes(needle);
    }) || matchYesNoRadio(group, answer);

    if (!matched) {
      continue;
    }

    matched.click();
    matched.dispatchEvent(new Event("change", { bubbles: true }));
  }

  const checkboxes = Array.from(document.querySelectorAll("input[type='checkbox']"));
  for (const checkbox of checkboxes) {
    if (!isElementVisible(checkbox) || checkbox.disabled || checkbox.checked) {
      continue;
    }
    const context = getFieldContext(checkbox);
    if (isSensitiveDiversityQuestion(context)) {
      continue;
    }
    if (/terms|privacy|policy|consent to receive|sms|text message/i.test(context)) {
      continue;
    }

    const answer = resolveFieldValue(context, profile);
    const wantsYes = /^(yes|true|y)$/i.test(String(answer || "").trim());
    if (!wantsYes) {
      continue;
    }
    checkbox.click();
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
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

  const questionText = getQuestionContextText(input);

  return [aria, placeholder, name, labelText, questionText].join(" ").toLowerCase();
}

function resolveFieldValue(context, profile) {
  const normalizedWorkAuth = normalizeText(profile.workAuthorization || "").toLowerCase();
  if (/citizenship|citizen|ethnicity|race|gender|veteran|disability/.test(context)) {
    return "";
  }
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
  if (/require sponsorship|need sponsorship|visa sponsorship|sponsorship/.test(context)) {
    if (/no sponsorship|do not require|dont require|does not require|no/i.test(normalizedWorkAuth)) {
      return "No";
    }
    if (/require|needs|yes/i.test(normalizedWorkAuth)) {
      return "Yes";
    }
    return "No";
  }
  if (/authorized|authorization|eligible to work|work authorization|legally authorized|visa/.test(context)) {
    if (/yes|authorized|citizen|green card|h1b|ead|tn|opt|cpt/i.test(normalizedWorkAuth)) {
      return "Yes";
    }
    if (/no|not authorized/i.test(normalizedWorkAuth)) {
      return "No";
    }
    return profile.workAuthorization || "Yes";
  }
  if (/relocate|relocation|travel/.test(context)) {
    return "Yes";
  }
  if (/on[-\s]?site|in[-\s]?office|come into (the )?office|hybrid|regular basis|commute/.test(context)) {
    return "Yes";
  }
  if (/background check|drug test/.test(context)) {
    return "Yes";
  }
  return "";
}

function getQuestionContextText(input) {
  const containers = [
    input.closest("[role='radiogroup']"),
    input.closest("fieldset"),
    input.closest("[data-testid*='question']"),
    input.closest("[class*='question']"),
    input.closest("section"),
    input.closest("form")
  ].filter(Boolean);

  for (const container of containers) {
    const text = normalizeText(container.textContent || "");
    if (text.length >= 12) {
      return text.slice(0, 700);
    }
  }

  return "";
}

function getChoiceLabel(input) {
  const id = input.getAttribute("id");
  if (id) {
    const label = document.querySelector(`label[for='${cssEscape(id)}']`);
    if (label) {
      return normalizeText(label.textContent || "");
    }
  }
  const wrapping = input.closest("label");
  if (wrapping) {
    return normalizeText(wrapping.textContent || "");
  }
  const sibling = input.parentElement?.textContent || "";
  return normalizeText(sibling);
}

function matchYesNoRadio(group, answer) {
  const yes = /^(yes|true|y)$/i.test(String(answer || "").trim());
  const no = /^(no|false|n)$/i.test(String(answer || "").trim());
  if (!yes && !no) {
    return null;
  }
  return group.find((radio) => {
    const label = getChoiceLabel(radio).toLowerCase();
    if (yes) {
      return /\byes\b|authorized|willing|able/.test(label);
    }
    return /\bno\b|not/.test(label);
  }) || null;
}

function matchYesNoOption(options, answer) {
  const yes = /^(yes|true|y)$/i.test(String(answer || "").trim());
  const no = /^(no|false|n)$/i.test(String(answer || "").trim());
  if (!yes && !no) {
    return null;
  }
  return options.find((opt) => {
    const label = normalizeText(opt.textContent || "").toLowerCase();
    if (yes) {
      return /\byes\b|authorized|willing|able/.test(label);
    }
    return /\bno\b|not/.test(label);
  }) || null;
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

function findWizardButtonByRegex(regex) {
  const candidates = Array.from(document.querySelectorAll("button, a[role='button'], a, input[type='button'], input[type='submit']"));
  return (
    candidates.find((element) => {
      if (!isElementVisible(element) || element.disabled) {
        return false;
      }

      const tag = element.tagName.toLowerCase();
      const type = (element.getAttribute("type") || "").toLowerCase();
      const rawText = tag === "input" ? (element.value || "") : (element.textContent || "");
      const text = normalizeText(rawText).toLowerCase();
      const aria = normalizeText(element.getAttribute("aria-label") || "").toLowerCase();
      const combined = `${text} ${aria}`;

      if (/cancel|close|skip to jobs|back to jobs/.test(combined)) {
        return false;
      }

      if (tag === "input" && !["submit", "button"].includes(type)) {
        return false;
      }

      return regex.test(combined);
    }) || null
  );
}

function hasFileUploadInput() {
  const fileInput = document.querySelector("input[type='file']");
  return Boolean(fileInput && isElementVisible(fileInput));
}

function isAlreadyAppliedCard(card) {
  const text = normalizeText(card?.textContent || "").toLowerCase();
  return /already applied|application submitted|withdraw application|application already submitted/.test(text);
}

function isAlreadyAppliedPage() {
  const url = location.href.toLowerCase();
  const title = normalizeText(document.title || "").toLowerCase();
  const body = normalizeText(document.body?.innerText || "").toLowerCase();
  if (/already-applied|application-history/.test(url)) {
    return true;
  }
  return /already applied|already submitted|application already submitted|withdraw application/.test(`${title} ${body}`);
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

function isSubmissionConfirmationPage() {
  const url = location.href.toLowerCase();
  const title = normalizeText(document.title || "").toLowerCase();
  const body = normalizeText(document.body?.innerText || "").toLowerCase();

  if (/application-submitted|apply-confirmation|thank/.test(url)) {
    return true;
  }

  if (/application submitted|thank you for applying|application received|you have applied/.test(body)) {
    return true;
  }

  if (/application submitted|thank you|applied/.test(title) && !url.includes("/wizard")) {
    return true;
  }

  return false;
}

function isSensitiveDiversityQuestion(context) {
  const value = String(context || "").toLowerCase();
  return /gender|sex|race|ethnicity|veteran|disability|pronoun|birth|date of birth|ssn|social security/.test(value);
}

async function runVisualFlowFallback({ profile, maxAttempts }) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (isAlreadyAppliedPage()) {
      return {
        status: "already_submitted",
        details: "Detected already-applied state during visual fallback."
      };
    }

    if (isSubmissionConfirmationPage()) {
      return {
        status: "submitted",
        details: "Submission confirmation detected during visual fallback."
      };
    }

    fillKnownFields(profile || {});

    const primaryButton = findWizardButtonByRegex(/next|continue|review|proceed|save and continue/i);
    if (!primaryButton) {
      continue;
    }

    primaryButton.click();
    await wait(1200);

    if (isSubmissionConfirmationPage()) {
      return {
        status: "submitted",
        details: "Submitted via visual fallback."
      };
    }

    return { advanced: true };
  }

  return { status: "unknown", details: "Visual fallback did not find a clear action." };
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
