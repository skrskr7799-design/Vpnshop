// The storefront is online-only. Requests go directly to the network and HTTP
// cache policy; this worker has no fetch handler and stores no account data.
self.addEventListener("message", event => {
  if (event.data === "mzt:activate-update") event.waitUntil(self.skipWaiting());
});
