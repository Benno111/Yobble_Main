(() => {
  if (window.__PHOTON_SDK_LOADER) return;
  window.__PHOTON_SDK_LOADER = true;

  const cfg = window.__PHOTON_CONFIG || {};
  const sdkUrl = cfg.sdkUrl || "/js/vendor/photon-realtime.min.js";

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[src="${src}"]`);
      if (existing) {
        if (existing.dataset.loaded === "true") return resolve();
        existing.addEventListener("load", () => resolve());
        existing.addEventListener("error", () => reject(new Error("photon_sdk_load_failed")));
        return;
      }
      const s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.dataset.loaded = "false";
      s.onload = () => {
        s.dataset.loaded = "true";
        resolve();
      };
      s.onerror = () => reject(new Error("photon_sdk_load_failed"));
      document.head.appendChild(s);
    });
  }

  loadScript(sdkUrl)
    .then(() => {
      window.dispatchEvent(new CustomEvent("photon:sdk-loaded"));
    })
    .catch((err) => {
      window.__PHOTON_SDK_ERROR = err?.message || "photon_sdk_load_failed";
      window.dispatchEvent(new CustomEvent("photon:sdk-error"));
    });
})();
