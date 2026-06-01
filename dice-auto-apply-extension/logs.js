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

    const timestampTd = document.createElement("td");
    timestampTd.textContent = new Date(entry.timestamp).toLocaleString();

    const levelTd = document.createElement("td");
    levelTd.textContent = entry.level || "";

    const sourceTd = document.createElement("td");
    sourceTd.textContent = entry.source || "";

    const messageTd = document.createElement("td");
    messageTd.textContent = entry.message || "";

    const dataTd = document.createElement("td");
    const pre = document.createElement("pre");
    pre.textContent = JSON.stringify(entry.data || {}, null, 2);
    dataTd.appendChild(pre);

    row.appendChild(timestampTd);
    row.appendChild(levelTd);
    row.appendChild(sourceTd);
    row.appendChild(messageTd);
    row.appendChild(dataTd);

    tableBody.appendChild(row);
  }
}

async function exportJson() {
  const logs = (await sendMessage({ type: "automation-get-logs" })).result || [];
  const blob = new Blob([JSON.stringify(logs, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  const now = new Date();
  const filename = `dice-automation-logs-${now.toISOString().replace(/[:.]/g, "-")}.json`;

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

