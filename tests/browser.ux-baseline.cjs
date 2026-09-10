const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { setupBrowser, wait } = require("./browser-harness.cjs");
const {
  prepareUxFixture,
  openUxPanels,
  measureWorkspace,
  withBrowserZoom,
} = require("./ux-fixture.cjs");

test(
  "capture the production UI baseline with disposable representative data",
  { timeout: 120000 },
  async (t) => {
    const h = await setupBrowser(t, {
      name: "ux-before",
      viewport: { width: 1440, height: 900 },
    });
    const fixture = await prepareUxFixture(h);
    await openUxPanels(h, fixture);
    const results = {
      evidenceStates: fixture.symbols.map((s) => ({
        name: s.name,
        state: s.state,
        ambiguous: !!s.ambiguousIdentity,
      })),
      sizes: {},
    };
    for (const [width, height] of [
      [1440, 900],
      [1280, 800],
      [800, 700],
    ]) {
      await h.page.setViewportSize({ width, height });
      await wait(250);
      results.sizes[`${width}x${height}`] = await measureWorkspace(h.page);
      await h.page.screenshot({
        path: path.join(h.output, `before-${width}x${height}.png`),
        fullPage: true,
      });
    }
    await h.page.setViewportSize({ width: 1280, height: 800 });
    const before = await measureWorkspace(h.page);
    for (let i = 0; i < 4; i++) await h.page.keyboard.press("Control++");
    await wait(200);
    results.zoomShortcut = { before, after: await measureWorkspace(h.page) };
    // In headless Chromium keyboard browser-chrome shortcuts may be unavailable.
    // This separate reflow stress check is explicitly CSS zoom, not a browser-zoom claim.
    await h.page.evaluate(() => (document.documentElement.style.zoom = "2"));
    await wait(200);
    results.cssZoom200 = await measureWorkspace(h.page);
    await h.page.screenshot({
      path: path.join(h.output, "before-css-zoom-200.png"),
      fullPage: true,
    });
    await h.page.evaluate(() => (document.documentElement.style.zoom = ""));
    await withBrowserZoom(h, async (zoomed, setZoom) => {
      await openUxPanels(zoomed, fixture);
      const factor = await setZoom(2);
      results.browserZoom200 = {
        factor,
        ...(await measureWorkspace(zoomed.page)),
      };
      await zoomed.page.screenshot({
        path: path.join(h.output, "before-browser-zoom-200.png"),
        fullPage: true,
      });
    });
    results.historicalEvidence = (
      await h.api(`/projects/${fixture.historicalId}/symbols`)
    ).symbols.map((s) => s.state);
    fs.writeFileSync(
      path.join(h.output, "measurements.json"),
      JSON.stringify(results, null, 2),
    );
    console.log("BASELINE_ARTIFACTS=" + h.output);
  },
);
