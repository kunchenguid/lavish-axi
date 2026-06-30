document.addEventListener("DOMContentLoaded", () => {
  const status = document.getElementById("runtime-status");
  if (status) status.textContent = "JavaScript inlined and running";
  document.documentElement.dataset.lavishExportReady = "true";
});
