import { useEffect, useState } from "react";
import { Button, Toast } from "@vpn/ui";

export function StorefrontUpdate() {
  const [waiting, setWaiting] = useState<ServiceWorker>();
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    if (!import.meta.env.PROD || !window.isSecureContext || !("serviceWorker" in navigator)) return;
    const controller = new AbortController();
    const { signal } = controller;
    void navigator.serviceWorker.register("/mzt-sw.js", { updateViaCache: "none" }).then(registration => {
      if (signal.aborted) return;

      function inspect() {
        if (registration.waiting && navigator.serviceWorker.controller) setWaiting(registration.waiting);
      }

      function observe() {
        registration.installing?.addEventListener("statechange", inspect, { signal });
      }

      inspect();
      observe();
      registration.addEventListener("updatefound", observe, { signal });
    }).catch(() => { /* Installation is optional and has no effect on the storefront. */ });
    return () => controller.abort();
  }, []);

  if (!waiting) return null;
  return <Toast>
    Доступно обновление интерфейса.
    <Button variant="secondary" loading={applying} onClick={() => {
      setApplying(true);
      waiting.addEventListener("statechange", () => {
        if (waiting.state === "activated") window.location.reload();
        if (waiting.state === "redundant") { setWaiting(undefined); setApplying(false); }
      });
      if (waiting.state === "activated") window.location.reload();
      else if (waiting.state === "redundant") { setWaiting(undefined); setApplying(false); }
      else waiting.postMessage("mzt:activate-update");
    }}>Обновить страницу</Button>
  </Toast>;
}
