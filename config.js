(() => {
  "use strict";

  const host = window.location.hostname;
  const isLocalHost =
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(?:1[6-9]|2\d|3[01])\./.test(host);
  const socketHost = host.includes(":") ? `[${host}]` : host;
  const socketProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const apiProtocol = window.location.protocol === "https:" ? "https:" : "http:";
  const hostedWorkerUrl = "wss://omeet-matchmaker.dassusuman2009.workers.dev/ws";
  const localServiceUrl = isLocalHost ? `${socketProtocol}//${socketHost}:8787` : "";
  const localApiUrl = isLocalHost ? `${apiProtocol}//${socketHost}:8787` : "";
  const hostedApiUrl = hostedWorkerUrl.replace(/^wss:/, "https:").replace(/\/ws$/, "");

  window.OMEET_CONFIG = Object.freeze({
    // Cloudflare Worker used by the public GitHub Pages site.
    matchmakingUrl: localServiceUrl ? `${localServiceUrl}/ws` : hostedWorkerUrl,
    apiUrl: localApiUrl || hostedApiUrl,
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
  });
})();
