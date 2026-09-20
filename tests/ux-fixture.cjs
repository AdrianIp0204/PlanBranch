/* A repeatable, disposable design-review fixture, built through public APIs. */
const fs = require("node:fs");
const path = require("node:path");
const { until, wait } = require("./browser-harness.cjs");
const { createRequire } = require("node:module");
const { chromium } = createRequire(
  path.resolve(__dirname, "../frontend/package.json"),
)("playwright");

async function prepareUxFixture(h) {
  const initialId = h.initial.id;
  const write = (file, text) =>
    fs.writeFileSync(path.join(h.sourceDir, file), text);
  async function scan(id) {
    const run = await h.api(`/projects/${id}/scans`, "POST", {});
    return until(async () => {
      const result = await h.api(`/projects/${id}/scans/${run.id}`);
      return ["queued", "running"].includes(result.status) ? false : result;
    }, 30000);
  }
  write(
    "importer.py",
    "def process_records(records):\n    count: int = 0\n    record: dict[str, str] = {}\n    return count\n",
  );
  write("stale.py", "previous_result: int = 1\n");
  write("missing.py", 'removed_binding: str = "old"\n');
  write(
    "ambiguous.py",
    "def repeated():\n    amount: int = 1\ndef repeated():\n    amount: int = 2\n",
  );
  await h.api(`/projects/${initialId}/source`, "POST", {
    root: h.sourceDir,
    ignores: [],
    confirmed: true,
  });
  await scan(initialId);
  const portable = await h.api(`/projects/${initialId}/export/json`);
  const historical = await h.api("/import", "POST", {
    ...portable,
    content: {
      ...portable.content,
      name: "Imported evidence · source not attached",
    },
  });
  const imported = await h.api("/import", "POST", portable);
  const id = imported.id;
  await h.api(`/projects/${id}/source`, "POST", {
    root: h.sourceDir,
    ignores: [],
    confirmed: true,
  });
  await scan(id);
  write("stale.py", "def broken(:\n");
  write(
    "missing.py",
    "# Binding intentionally removed in this disposable fixture.\n",
  );
  await scan(id);
  const symbols = (await h.api(`/projects/${id}/symbols`)).symbols;
  const empty = await h.api("/projects", "POST", { name: "An empty project" });
  const envelope = await h.saveContent(
    id,
    (c) => {
      c.name = "Batch importer · planning and evidence review";
      c.notes =
        "Plan first, then compare the read-only Python observations. This project is disposable UI review data.\n\n" +
        "Long notes stay editable and readable without changing what a scan means. ".repeat(
          12,
        );
      const diagram = c.diagrams[0];
      const selected = diagram.nodes.find((n) => n.type === "decision");
      selected.title =
        "Validate incoming records before writing any changes to persistent storage";
      selected.notes =
        "Preserve the original source record and explain every rejected field. ".repeat(
          9,
        );
      selected.status = "blocked";
      selected.blocker =
        "Confirm how malformed identifiers should be reported to the caller.";
      selected.pseudocode =
        "if has_required_fields(record):\n    validate_identifier(record)\nelse:\n    retain_for_review(record)";
      diagram.name =
        "Import records and recover safely from incomplete or malformed batches";
      const node = structuredClone(
        diagram.nodes.find((n) => n.type === "process"),
      );
      node.id = crypto.randomUUID();
      node.title =
        "Review rejected records with enough context to retry safely";
      node.position = { x: 100, y: 100 };
      node.checklist = [];
      c.diagrams.push({
        id: crypto.randomUUID(),
        name: "Review & recovery",
        nodes: [node],
        edges: [],
      });
      const count = c.variables.find((v) => v.name === "count");
      c.nodeLinks.push({
        id: crypto.randomUUID(),
        nodeId: node.id,
        variableId: count.id,
        origin: "planned",
        relationship: "reads",
      });
      for (const name of ["count", "record"]) {
        const plan = c.variables.find((v) => v.name === name);
        const evidence = symbols.find(
          (s) => s.name === name && s.state === "current",
        );
        c.matches.push({
          id: crypto.randomUUID(),
          plannedId: plan.id,
          symbolId: evidence.id,
          decision: "confirmed",
        });
      }
      c.variables.push({
        id: crypto.randomUUID(),
        name: "future_validation_results_for_rejected_input_records",
        description: "Collect diagnostics without marking the plan complete.",
        intendedType: "list[ValidationResult]",
        intendedFile: "future/not_yet_created/validation_pipeline.py",
        scopeKind: "function",
        scope: "pipeline.collect_diagnostics",
        initialExpression: "[]",
        notes: "An intended variable; this file does not exist.",
        status: "not_started",
      });
    },
    "Prepare representative UI review data",
  );
  await h.page.reload();
  await h.page.getByTestId("diagram-canvas").waitFor();
  const decision = envelope.content.diagrams[0].nodes.find(
    (n) => n.type === "decision",
  );
  const plan = envelope.content.variables.find((v) => v.name === "count");
  return {
    id,
    emptyId: empty.id,
    historicalId: historical.id,
    envelope,
    decision,
    plan,
    symbols,
  };
}

async function openUxPanels(h, fixture) {
  const p = h.page;
  if (
    !(await p
      .locator(`.react-flow__node[data-id="${fixture.decision.id}"]`)
      .count())
  ) {
    const toggle = p.getByRole("button", {
      name: "Toggle navigation",
      exact: true,
    });
    if (
      (await toggle.count()) &&
      (await toggle.getAttribute("aria-expanded")) === "false"
    )
      await toggle.click();
    await p
      .getByRole("navigation", { name: "Diagrams" })
      .getByRole("button")
      .filter({ hasText: fixture.envelope.content.diagrams[0].name })
      .click();
  }
  // Returning from another diagram restores its saved viewport. Bring the
  // fixture into view before selecting it, just as a user can with Fit view.
  await p.locator(".react-flow__controls-fitview").click();
  await p
    .locator(`.react-flow__node[data-id="${fixture.decision.id}"]`)
    .dblclick();
  if (!(await p.getByRole("region", { name: "Variable catalogue" }).count()))
    await p.getByRole("button", { name: /Open catalogue/ }).click();
  // The compact catalogue shows either the selected details or the result
  // table. Return through its visible List action before choosing a record.
  const closeDetails = p.getByRole("button", {
    name: "Close variable details",
    exact: true,
  });
  if (
    !(await p.locator(".variable-panel .table-scroll").isVisible()) &&
    (await closeDetails.isVisible())
  )
    await closeDetails.click();
  await p
    .locator(`tr[data-variable-id="${fixture.plan.id}"]`)
    .getByRole("button")
    .click();
  await wait(250);
}

async function measureWorkspace(page) {
  return page.evaluate(() => {
    const rect = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      };
    };
    const text = [
      ...document.querySelectorAll("button,label,th,td,.save-state,.muted"),
    ]
      .filter((el) => el.getClientRects().length)
      .map((el) => ({
        text: el.textContent.trim().slice(0, 80),
        font: parseFloat(getComputedStyle(el).fontSize),
      }));
    return {
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      document: {
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
      },
      canvas: rect('[data-testid="diagram-canvas"]'),
      inspector: rect(".inspector"),
      catalogue: rect(".variable-panel"),
      detail: rect(".variable-detail"),
      smallText: text.filter((x) => x.font < 12),
      essential: [...document.querySelectorAll("button,summary")]
        .filter((el) =>
          /^(Save|Undo|Redo|Export|Scan Python|Connect)$/.test(
            el.textContent.trim(),
          ),
        )
        .map((el) => ({
          label: el.textContent.trim(),
          ...(() => {
            const r = el.getBoundingClientRect();
            return {
              x: r.x,
              y: r.y,
              width: r.width,
              height: r.height,
              visible: r.width > 0 && r.height > 0,
            };
          })(),
        })),
    };
  });
}

async function measureContrast(page) {
  return page.evaluate(() => {
    const rgba = (value) => {
      const values = value.match(/[\d.]+/g)?.map(Number) || [];
      return [values[0] || 0, values[1] || 0, values[2] || 0, values[3] ?? 1];
    };
    const luminance = (rgb) =>
      rgb
        .slice(0, 3)
        .map((c) => {
          const v = c / 255;
          return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        })
        .reduce((n, c, i) => n + c * [0.2126, 0.7152, 0.0722][i], 0);
    const selectors = [
      ".save-state",
      ".save-state small",
      ".inspector .field > label",
      ".catalogue-filter span",
      ".catalogue-results",
      ".variable-list th",
      ".variable-detail-header h3",
      ".section-indicator",
      ".task-kind",
      ".task-meta",
      ".flow-edge-label",
    ];
    return selectors.flatMap((selector) => {
      const el = [...document.querySelectorAll(selector)].find(
        (e) => e.getClientRects().length,
      );
      if (!el) return [];
      const foreground = rgba(getComputedStyle(el).color);
      let background = [255, 255, 255, 1],
        ancestors = [];
      for (let ancestor = el; ancestor; ancestor = ancestor.parentElement)
        ancestors.unshift(ancestor);
      for (const ancestor of ancestors) {
        const c = rgba(getComputedStyle(ancestor).backgroundColor);
        background = background.map((value, index) =>
          index < 3 ? c[index] * c[3] + value * (1 - c[3]) : 1,
        );
      }
      const color = foreground.map((value, index) =>
        index < 3
          ? value * foreground[3] + background[index] * (1 - foreground[3])
          : 1,
      );
      const a = luminance(color),
        b = luminance(background);
      return [
        {
          selector,
          text: el.textContent.trim().slice(0, 80),
          foreground: color.slice(0, 3),
          background: background.slice(0, 3),
          ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
        },
      ];
    });
  });
}

// This changes the browser's actual per-tab page zoom (not CSS or pinch zoom).
// The extension and browser profile only exist in this disposable test output.
async function withBrowserZoom(h, run) {
  const extension = path.join(h.output, "zoom-extension");
  fs.mkdirSync(extension, { recursive: true });
  fs.writeFileSync(
    path.join(extension, "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      name: "FlowDesk disposable browser zoom verification",
      version: "1.0",
      permissions: ["tabs"],
      background: { service_worker: "worker.js" },
    }),
  );
  fs.writeFileSync(
    path.join(extension, "worker.js"),
    "chrome.runtime.onInstalled.addListener(()=>{});",
  );
  const channel =
    process.env.FLOWDESK_BROWSER_CHANNEL ||
    (fs.existsSync(chromium.executablePath())
      ? "chromium"
      : process.platform === "win32"
        ? "msedge"
        : "chromium");
  const context = await chromium.launchPersistentContext(
    path.join(h.output, "zoom-profile"),
    {
      channel,
      headless: true,
      viewport: { width: 1280, height: 800 },
      args: [
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
      ],
    },
  );
  try {
    await context.route("**/*", (route) => {
      const url = route.request().url();
      if (/^https?:/.test(url) && new URL(url).origin !== h.base) {
        h.externalRequests.push(url);
        return route.abort();
      }
      return route.continue();
    });
    const page = context.pages()[0] || (await context.newPage());
    page.on("pageerror", (error) => h.errors.push(error.message));
    page.on("dialog", (dialog) => dialog.accept());
    const worker =
      context.serviceWorkers()[0] ||
      (await context.waitForEvent("serviceworker", { timeout: 10000 }));
    await page.goto(h.base);
    await page.getByTestId("diagram-canvas").waitFor();
    const setZoom = async (factor) => {
      const actual = await worker.evaluate(
        async ({ origin, factor }) => {
          const tabs = await chrome.tabs.query({});
          const tab = tabs.find((tab) => tab.url?.startsWith(origin));
          if (!tab) throw new Error("No fixture tab found for browser zoom");
          await chrome.tabs.setZoom(tab.id, factor);
          return chrome.tabs.getZoom(tab.id);
        },
        { origin: h.base, factor },
      );
      await wait(250);
      return actual;
    };
    await run({ ...h, page, context }, setZoom);
  } finally {
    await context.close();
  }
}

module.exports = {
  prepareUxFixture,
  openUxPanels,
  measureWorkspace,
  measureContrast,
  withBrowserZoom,
};
