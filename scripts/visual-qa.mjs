import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";

const ingress = readFileSync(new URL("../ops/nginx/edge.conf", import.meta.url), "utf8");
const csp = ingress.match(/add_header Content-Security-Policy "([^"]+)" always;/)?.[1];
assert.ok(csp, "The TLS edge must define the document CSP");

export function serveAsset(req, res, mime, filename, body, { pwa = false } = {}) {
  res.setHeader("Content-Type", mime);
  if (filename.endsWith(".html")) res.setHeader("Content-Security-Policy", csp.replaceAll("${EDGE_BROWSER_PWA}", pwa ? "'self'" : "'none'"));
  if (/\.(css|js|html)$/.test(filename) && /\bgzip\b/.test(req.headers["accept-encoding"] ?? "")) {
    res.setHeader("Content-Encoding", "gzip");
    res.setHeader("Vary", "Accept-Encoding");
    res.end(gzipSync(body));
  } else res.end(body);
}

const viewports = [320, 360, 375, 390, 428, 430, 768, 1024, 1440, 1920];
const textExists = value => "Boolean(document.querySelector('main')?.innerText.includes(" + JSON.stringify(value) + "))";
const monitor = `
  window.__mztMetrics = { lcp: null, cls: 0 };
  new PerformanceObserver(list => {
    for (const entry of list.getEntries()) window.__mztMetrics.lcp = entry.startTime;
  }).observe({ type: "largest-contentful-paint", buffered: true });
  new PerformanceObserver(list => {
    for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.__mztMetrics.cls += entry.value;
  }).observe({ type: "layout-shift", buffered: true });
`;

export async function visualQa({ site, dist, send, evaluate, until, origin, screens, prepare, afterLoad }) {
  const output = join(process.env.MZT_VISUAL_DIR, site);
  await mkdir(output, { recursive: true });
  await send("Page.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", { source: monitor });
  const metrics = { responsive: [], performance: [], assets: {}, accessibility: {} };
  const viewport = (width, height = 900) => send("Emulation.setDeviceMetricsOverride", {
    width, height, deviceScaleFactor: 1, mobile: width < 768,
  });
  async function visit(screen) {
    await prepare(screen);
    if (new URL(screen.path, origin).hash) {
      await send("Page.navigate", { url: "about:blank" });
      await until('location.href === "about:blank"');
    }
    await evaluate("window.__mztPreviousDocument = true");
    await send("Page.navigate", { url: origin + screen.path });
    await until(`!window.__mztPreviousDocument && location.pathname === ${JSON.stringify(new URL(screen.path, origin).pathname)}`);
    await until(textExists(screen.ready));
    if (screen.afterLoad) await afterLoad(screen);
    await until("document.fonts.status === 'loaded'");
    await until(`(() => {
      const marks = [...document.querySelectorAll(".mz-brand-mark")].filter(mark => mark.checkVisibility());
      return marks.length === 1 && marks.every(mark => mark.complete && mark.naturalWidth > 0);
    })()`);
    assert.ok(await evaluate(`(() => {
      const mark = [...document.querySelectorAll(".mz-brand-mark")].find(mark => mark.checkVisibility());
      const { width, height } = mark.getBoundingClientRect();
      const home = mark.closest("a")?.getBoundingClientRect();
      return mark.alt === "MZT" && new URL(mark.currentSrc).origin === location.origin
        && mark.naturalWidth === mark.naturalHeight && width === height
        && (!home || (home.width >= 44 && home.height >= 44));
    })()`), `${site} ${screen.id} local square logo and usable home target`);
  }

  for (const screen of screens) {
    for (const width of viewports) {
      await viewport(width, width < 768 ? 844 : screen.id === "login" ? 810 : 920);
      await visit(screen);
      const geometry = await evaluate(`({
        viewport: innerWidth, root: document.documentElement.scrollWidth,
        headings: document.querySelectorAll('main h1').length,
        modal: (() => {
          const rect = document.querySelector("dialog[open]:not(.mz-drawer)")?.getBoundingClientRect();
          return !rect || Math.abs(rect.top + rect.bottom - innerHeight) <= 8;
        })(),
        unlabeled: [...document.querySelectorAll('input,select,textarea')].filter(x => x.checkVisibility() &&
          !x.labels?.length && !x.getAttribute('aria-label') && !x.hasAttribute('aria-labelledby')).map(x => x.name),
        narrow: [...document.querySelectorAll('.mz-button, .mz-mobile-nav > a, .mz-mobile-nav > button')].filter(x => x.checkVisibility() &&
          (x.offsetHeight < 44 || x.offsetWidth < 44)).map(x => x.textContent.trim())
      })`);
      assert.ok(geometry.root <= width && geometry.viewport === width, `${site} ${screen.id} overflow at ${width}: ${JSON.stringify(geometry)}`);
      assert.equal(geometry.headings, 1, `${site} ${screen.id} page heading`);
      assert.ok(geometry.modal, `${site} ${screen.id} centered dialog at ${width}px`);
      assert.deepEqual(geometry.unlabeled, [], `${site} ${screen.id} field labels`);
      assert.deepEqual(geometry.narrow, [], `${site} ${screen.id} control targets`);
      metrics.responsive.push({ screen: screen.id, width });
      if (width === 390 || width === 1440) {
        await evaluate("window.scrollTo(0,0)");
        await delay(200);
        const screenshot = await send("Page.captureScreenshot", { format: "png" });
        await writeFile(join(output, `${screen.id}-${width}.png`), Buffer.from(screenshot.data, "base64"));
      }
    }
  }

  await viewport(390, 844);
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await visit(screens[0]);
  assert.equal(await evaluate("matchMedia('(prefers-reduced-motion: reduce)').matches"), true);
  assert.equal(await evaluate("Number.parseFloat(getComputedStyle(document.querySelector('.mz-button')).transitionDuration) <= 0.00001"), true);
  await send("Emulation.setEmulatedMedia", { features: [] });
  // Half of a 640 px window exercises reflow at 200% browser zoom without a physical device.
  const zoomScreens = screens.filter(screen => ["login", "dashboard", "connection", "checkout", "security", "users",
    "order-finance", "offer-confirmation"].includes(screen.id));
  for (const screen of zoomScreens) {
    await viewport(320, 844);
    await visit(screen);
    await send("Emulation.setPageScaleFactor", { pageScaleFactor: 2 });
    assert.ok(await evaluate("document.documentElement.scrollWidth <= innerWidth"), `${site} ${screen.id} reflow`);
    await send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
    await evaluate("document.body.style.zoom = 2");
    await viewport(640, 900);
    assert.ok(await evaluate("document.documentElement.scrollWidth <= innerWidth"), `${site} ${screen.id} 200% layout`);
    await evaluate("document.body.style.removeProperty('zoom')");
  }
  const contrast = await evaluate(`(() => {
    const style = getComputedStyle(document.documentElement);
    const luminance = token => {
      const hex = style.getPropertyValue(token).trim().slice(1);
      const [r, g, b] = hex.match(/../g).map(part => parseInt(part, 16) / 255)
        .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
      return .2126 * r + .7152 * g + .0722 * b;
    };
    const pair = (first, second) => {
      const levels = [luminance(first), luminance(second)].sort((a,b) => b - a);
      return Number(((levels[0] + .05) / (levels[1] + .05)).toFixed(2));
    };
    return {
      body: pair('--mz-text','--mz-surface'), secondary: pair('--mz-muted','--mz-raised'),
      primaryButton: pair('--mz-on-violet','--mz-violet'), fieldBorder: pair('--mz-control-border','--mz-raised'),
      focus: pair('--mz-focus','--mz-base'), danger: pair('--mz-danger','--mz-danger-bg'),
      success: pair('--mz-success','--mz-success-bg'), warning: pair('--mz-warning','--mz-warning-bg'),
    };
  })()`);
  for (const [pair, ratio] of Object.entries(contrast)) {
    assert.ok(ratio >= (pair === "fieldBorder" || pair === "focus" ? 3 : 4.5), `${pair} contrast: ${ratio}`);
  }
  metrics.accessibility = { reducedMotion: true, formLabels: true, mainHeadings: true, primaryTargetsCssPx: 44,
    reflowCssPx: 320, zoom: 2, zoomScreens: zoomScreens.map(screen => screen.id), contrast };

  const files = await readdir(join(dist, "assets"));
  for (const file of files) {
    const data = await readFile(join(dist, "assets", file));
    metrics.assets[file] = { bytes: data.length, gzip: gzipSync(data).length };
  }
  const index = Object.entries(metrics.assets).find(([name]) => /^index-.*\.js$/.test(name));
  const css = Object.entries(metrics.assets).find(([name]) => /^index-.*\.css$/.test(name));
  assert.ok(index && index[1].gzip <= 150 * 1024, "First route JS gzip budget");
  assert.ok(css && css[1].gzip <= 25 * 1024, "First route CSS gzip budget");
  const fonts = Object.entries(metrics.assets).filter(([name]) => name.endsWith(".woff2"));
  assert.ok(fonts.reduce((sum, [, asset]) => sum + asset.bytes, 0) <= 90 * 1024, "Font budget");

  await viewport(390, 844);
  await send("Network.setCacheDisabled", { cacheDisabled: true });
  await send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await send("Network.emulateNetworkConditions", { offline: false, latency: 150,
    downloadThroughput: 200_000, uploadThroughput: 94_000, connectionType: "cellular4g" });
  for (const screen of screens.filter(item => item.measure)) {
    const samples = [];
    for (let pass = 0; pass < 3; pass++) {
      await visit(screen);
      await delay(500);
      samples.push(await evaluate(`({
        ...window.__mztMetrics,
        transferBytes: performance.getEntriesByType("resource").reduce((size, entry) => size + entry.transferSize, 0)
          + performance.getEntriesByType("navigation")[0].transferSize
      })`));
    }
    samples.sort((a, b) => (a.lcp ?? Infinity) - (b.lcp ?? Infinity));
    metrics.performance.push({ screen: screen.id, median: samples[1], samples });
  }
  await send("Emulation.setCPUThrottlingRate", { rate: 1 });
  await send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await writeFile(join(output, "qa.json"), JSON.stringify(metrics, null, 2) + "\n");
  console.log(`${site}: ${metrics.responsive.length} viewport checks; screenshot and performance evidence in ${output}`);
}
