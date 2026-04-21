const tableBody = document.getElementById("logTableBody");
const summary = document.getElementById("summary");
const levelFilter = document.getElementById("levelFilter");

document.getElementById("refreshBtn").addEventListener("click", render);
document.getElementById("exportBtn").addEventListener("click", exportJson);
document.getElementById("clearBtn").addEventListener("click", clearLogs);
levelFilter.addEventListener("change", render);

document.addEventListener("DOMContentLoaded", render);

async function render() {
  const logs = (await sendMessage({ type: "automation-get-logs" })).result || [];
  const level = levelFilter.value;
  const filtered = level === "all" ? logs : logs.filter((entry) => entry.level === level);

  const counts = {
    info: logs.filter((entry) => entry.level === "info").length,
    warn: logs.filter((entry) => entry.level === "warn").length,
    error: logs.filter((entry) => entry.level === "error").length
  };

  summary.textContent = `Total logs: ${logs.length} | info: ${counts.info} | warn: ${counts.warn} | error: ${counts.error}`;

  tableBody.innerHTML = "";
  const recentFirst = [...filtered].reverse();

  for (const entry of recentFirst) {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${escapeHtml(new Date(entry.timestamp).toLocaleString())}</td>
      <td>${escapeHtml(entry.level || "")}</td>
      <td>${escapeHtml(entry.source || "")}</td>
      <td>${escapeHtml(entry.message || "")}</td>
      <td><pre>${escapeHtml(JSON.stringify(entry.data || {}, null, 2))}</pre></td>
    `;
    tableBody.appendChild(row);
  }
}

async function exportJson() {
  const logs = (await sendMessage({ type: "automation-get-logs" })).result || [];
  const blob = new Blob([JSON.stringify(logs, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  const now = new Date();
  const filename = `indeed-automation-logs-${now.toISOString().replace(/[:.]/g, "-")}.json`;

  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();

  URL.revokeObjectURL(url);
}

async function clearLogs() {
  await sendMessage({ type: "automation-clear-logs" });
  await render();
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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
