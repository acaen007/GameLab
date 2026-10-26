// Surface uncaught errors in the page (CSP forbids inline scripts, so this lives in its own file).
(function () {
  "use strict";
  function show(message) {
    const box = document.getElementById("fatal");
    if (!box) return;
    box.hidden = false;
    box.textContent = "Unexpected error: " + message;
  }
  window.addEventListener("error", (e) => show(e.message || String(e.error)));
  window.addEventListener("unhandledrejection", (e) => show(e.reason && e.reason.message ? e.reason.message : String(e.reason)));
})();
