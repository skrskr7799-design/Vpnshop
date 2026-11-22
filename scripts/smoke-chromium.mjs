import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

export async function launchChromium(profile) {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));

  const browser = spawn(process.env.CHROMIUM_BIN ?? "chromium", [
    "--headless", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--no-first-run",
    "--disable-background-networking", "--disable-breakpad", "--no-default-browser-check",
    "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=" + port,
    "--user-data-dir=" + profile, "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let diagnostic = "";
  let launchError;
  browser.on("error", error => { launchError = error; });
  browser.stderr.setEncoding("utf8");
  browser.stderr.on("data", value => { diagnostic = (diagnostic + value).slice(-3500); });
  const close = async () => {
    if (!browser.pid || browser.exitCode !== null || browser.signalCode !== null) return;
    const exit = once(browser, "exit");
    browser.kill("SIGTERM");
    await Promise.race([exit, delay(2000, undefined, { ref: false })]);
    if (browser.exitCode === null && browser.signalCode === null) {
      browser.kill("SIGKILL");
      await exit;
    }
  };

  try {
    for (let i = 0; i < 150; i++) {
      if (launchError) throw launchError;
      if (browser.exitCode !== null || browser.signalCode !== null) break;
      const targets = await fetch("http://127.0.0.1:" + port + "/json/list", { signal: AbortSignal.timeout(500) })
        .then(response => response.ok ? response.json() : [], () => []);
      const target = targets.find(item => item.type === "page" && item.url === "about:blank");
      if (target) {
        const ws = new WebSocket(target.webSocketDebuggerUrl);
        await once(ws, "open", { signal: AbortSignal.timeout(5000) });
        return { ws, close };
      }
      await delay(100);
    }
    throw new Error("Chromium DevTools unavailable. " + diagnostic.replace(/\s+/g, " ").trim());
  } catch (error) {
    await close();
    throw error;
  }
}
