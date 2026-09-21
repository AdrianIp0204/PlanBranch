const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { setupBrowser, until } = require("./browser-harness.cjs");

const workspace = (p) =>
  p.getByRole("region", { name: "Proposed changes workspace" });
const proposalUrl = (h, proposal) =>
  `/projects/${h.initial.id}/planning/proposals/${proposal.id}`;
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

async function openChat(p) {
  await p.getByTestId("diagram-canvas").waitFor();
  const chat = p.getByRole("complementary", { name: "Planning conversation" });
  if (!(await chat.isVisible()))
    await p
      .getByRole("button", { name: "Toggle planning chat", exact: true })
      .click();
  await p.getByRole("tab", { name: "Chat", exact: true }).click();
}

async function makeProposal(h) {
  await openChat(h.page);
  await h.page
    .getByLabel("Message Codex", { exact: true })
    .fill("Add a review step");
  await h.page.getByRole("button", { name: "Send", exact: true }).click();
  const planning = await until(async () => {
    const state = await h.api(`/projects/${h.initial.id}/planning`);
    return state.request?.status === "succeeded" && state.proposals.length
      ? state
      : false;
  });
  await workspace(h.page).waitFor();
  await until(
    async () =>
      (await workspace(h.page).locator(".react-flow__node").count()) ===
      h.initial.content.diagrams[0].nodes.length + 1,
  );
  return planning.proposals.at(-1);
}

async function openProposal(p) {
  await openChat(p);
  if (!(await workspace(p).isVisible())) {
    await p.getByRole("tab", { name: /^Changes/ }).click();
    await p
      .getByRole("button", { name: "Review on canvas", exact: true })
      .first()
      .click();
  }
  await workspace(p).waitFor();
}

async function editTitle(p, title) {
  const input = workspace(p).getByLabel("Title", { exact: true });
  if (!(await input.isVisible())) {
    const toggle = workspace(p).getByRole("button", {
      name: "Edit manually",
      exact: true,
    });
    if (await toggle.isVisible()) await toggle.click();
    await workspace(p).locator(".react-flow__node").first().dblclick();
  }
  await input.fill(title);
  await input.press("Tab");
}

async function draftSaved(p) {
  await until(async () =>
    /^Draft saved\b/.test(
      (await p.getByTestId("proposal-draft-state").innerText()).trim(),
    ),
  );
}

async function currentDraft(h, proposal, predicate = () => true) {
  return until(async () => {
    const list = await h.api(proposalUrl(h, proposal) + "/drafts");
    if (!list.defaultDraftId) return false;
    const { draft } = await h.api(
      proposalUrl(h, proposal) + "/drafts/" + list.defaultDraftId,
    );
    return predicate(draft) ? draft : false;
  });
}

async function isolatedPage(t, h) {
  const context = await h.context.browser().newContext({
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
  });
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (/^https?:/.test(url) && new URL(url).origin !== h.base) {
      h.externalRequests.push(url);
      return route.abort();
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => h.errors.push(error.message));
  page.on("dialog", (dialog) => dialog.accept());
  t.after(async () => {
    if (!page.isClosed())
      await page
        .screenshot({
          path: path.join(
            h.output,
            `recovered-${Math.random().toString(16).slice(2)}.png`,
          ),
        })
        .catch(() => {});
    await context.close().catch(() => {});
  });
  await page.goto(h.base);
  await page.getByTestId("diagram-canvas").waitFor();
  return { page, context };
}

async function rawApi(h, url, method, body) {
  const token = (await (await fetch(h.base + "/api/bootstrap")).json()).token;
  return fetch(h.base + "/api" + url, {
    method,
    headers: { "X-FlowDesk-Token": token, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test(
  "proposal candidate survives a closed browser and server restart without changing saved content or approval snapshot",
  { timeout: 120000 },
  async (t) => {
    const h = await setupBrowser(t, {
      name: "durable-draft-restart",
      planningFixture: true,
      viewport: { width: 1280, height: 800 },
    });
    const original = await h.api(`/projects/${h.initial.id}`);
    const approved = await h.api(
      `/projects/${h.initial.id}/planning/approve`,
      "POST",
      { baseRevision: original.revision, mutationId: crypto.randomUUID() },
    );
    const proposal = await makeProposal(h);
    await editTitle(h.page, "Recover this candidate after closing the browser");
    await workspace(h.page)
      .getByLabel("Description", { exact: true })
      .fill("Manual requirements remain separate from the approved plan.");
    await workspace(h.page)
      .getByLabel("Description", { exact: true })
      .press("Tab");
    await draftSaved(h.page);
    const draft = await currentDraft(
      h,
      proposal,
      (row) =>
        row.candidate.diagrams[0].nodes[0].title ===
        "Recover this candidate after closing the browser",
    );
    assert.equal(draft.state, "active");
    assert.equal(draft.proposalId, proposal.id);
    assert.equal(draft.baseHash, proposal.baseHash);
    assert.deepEqual(await h.api(`/projects/${h.initial.id}`), original);
    assert.deepEqual(
      (await h.api(`/projects/${h.initial.id}/planning`)).approval.snapshot,
      approved.approval.snapshot,
    );
    await h.page.screenshot({
      path: path.join(h.output, "draft-saved-1280.png"),
    });

    await h.context.close();
    await h.restart({ reload: false });
    const fresh = await isolatedPage(t, h);
    await openProposal(fresh.page);
    await workspace(fresh.page)
      .getByText("Recover this candidate after closing the browser", {
        exact: true,
      })
      .waitFor();
    await draftSaved(fresh.page);
    const recovered = (
      await h.api(proposalUrl(h, proposal) + "/drafts/" + draft.id)
    ).draft;
    assert.deepEqual(recovered.candidate, draft.candidate);
    assert.deepEqual(await h.api(`/projects/${h.initial.id}`), original);
    await fresh.page.screenshot({
      path: path.join(h.output, "draft-recovered-1440.png"),
    });
  },
);

test(
  "late draft acknowledgements and failed saves retain newer edits and retry the same batch",
  { timeout: 120000 },
  async (t) => {
    const h = await setupBrowser(t, {
      name: "durable-draft-ordering",
      seed: { name: "Draft ordering" },
      planningFixture: true,
    });
    const proposal = await makeProposal(h);
    const committed = deferred(),
      release = deferred();
    const writes = [];
    let hold = true,
      fail = false;
    await h.page.route("**/planning/proposals/*/drafts/*", async (route) => {
      if (route.request().method() !== "PUT") return route.continue();
      const body = route.request().postDataJSON();
      writes.push(body);
      if (hold) {
        hold = false;
        const response = await route.fetch();
        committed.resolve(body);
        await release.promise;
        return route.fulfill({ response });
      }
      if (fail) {
        fail = false;
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "Disposable draft save failure" }),
        });
      }
      return route.continue();
    });
    t.after(() => release.resolve());
    await editTitle(h.page, "First saved request");
    await committed.promise;
    await editTitle(h.page, "Newer edit while acknowledgement waits");
    release.resolve();
    await draftSaved(h.page);
    assert.equal(
      await workspace(h.page).getByLabel("Title", { exact: true }).inputValue(),
      "Newer edit while acknowledgement waits",
    );
    await currentDraft(
      h,
      proposal,
      (row) =>
        row.candidate.diagrams[0].nodes[0].title ===
        "Newer edit while acknowledgement waits",
    );
    assert.ok(writes.length >= 2, "Newer content gets its own saved batch");

    fail = true;
    await editTitle(h.page, "Save failure retains this batch");
    const retry = h.page.getByRole("button", {
      name: "Retry draft save",
      exact: true,
    });
    await until(
      async () =>
        (
          await h.page.getByTestId("proposal-draft-state").innerText()
        ).trim() === "Draft not saved",
    );
    await h.page
      .getByRole("alert")
      .filter({ hasText: "Disposable draft save failure" })
      .waitFor();
    const failed = writes.at(-1);
    await editTitle(h.page, "Newest edit while failed batch waits");
    await retry.click();
    await draftSaved(h.page);
    await currentDraft(
      h,
      proposal,
      (row) =>
        row.candidate.diagrams[0].nodes[0].title ===
        "Newest edit while failed batch waits",
    );
    assert.ok(
      writes.filter((body) => body.mutationId === failed.mutationId).length >=
        2,
      "Retry reuses the uncertain batch identity",
    );
    assert.equal(
      await workspace(h.page).getByLabel("Title", { exact: true }).inputValue(),
      "Newest edit while failed batch waits",
    );
    assert.equal(
      (await h.api(`/projects/${h.initial.id}`)).content.diagrams[0].nodes
        .length,
      0,
    );
  },
);

test(
  "conflicting browser drafts preserve both candidates and let the user continue their recovery copy",
  { timeout: 120000 },
  async (t) => {
    const h = await setupBrowser(t, {
      name: "durable-draft-conflict",
      seed: { name: "Conflicting review" },
      planningFixture: true,
    });
    const proposal = await makeProposal(h);
    await editTitle(h.page, "Shared draft baseline");
    await draftSaved(h.page);
    const baseline = await currentDraft(h, proposal);
    const other = await isolatedPage(t, h);
    await openProposal(other.page);
    await workspace(other.page)
      .getByText("Shared draft baseline", { exact: true })
      .waitFor();
    await editTitle(h.page, "First tab saved its change");
    await draftSaved(h.page);
    await editTitle(other.page, "Second tab keeps a recovery copy");
    await other.page
      .getByRole("button", { name: "Use my copy", exact: true })
      .waitFor();
    assert.match(
      await other.page.getByTestId("proposal-draft-state").innerText(),
      /Draft conflict/,
    );
    const latest = (
      await h.api(proposalUrl(h, proposal) + "/drafts/" + baseline.id)
    ).draft;
    assert.equal(
      latest.candidate.diagrams[0].nodes[0].title,
      "First tab saved its change",
    );
    const rows = (await h.api(proposalUrl(h, proposal) + "/drafts")).drafts;
    const recovery = rows.find(
      (row) => row.conflictOf === baseline.id && row.state === "active",
    );
    assert.ok(
      recovery,
      "The rejected CAS save creates a durable recovery candidate",
    );
    assert.equal(
      (await h.api(proposalUrl(h, proposal) + "/drafts/" + recovery.id)).draft
        .candidate.diagrams[0].nodes[0].title,
      "Second tab keeps a recovery copy",
    );
    await other.page
      .getByRole("button", { name: "Use my copy", exact: true })
      .click();
    await draftSaved(other.page);
    assert.equal(
      await workspace(other.page)
        .getByLabel("Title", { exact: true })
        .inputValue(),
      "Second tab keeps a recovery copy",
    );
    await editTitle(other.page, "Recovery copy can continue independently");
    await draftSaved(other.page);
    assert.equal(
      (await h.api(proposalUrl(h, proposal) + "/drafts/" + baseline.id)).draft
        .candidate.diagrams[0].nodes[0].title,
      "First tab saved its change",
    );
    assert.equal(
      (await h.api(`/projects/${h.initial.id}`)).content.diagrams[0].nodes
        .length,
      0,
    );
  },
);

test(
  "interrupted Apply restores its intent and a committed retry remains exactly one history action",
  { timeout: 150000 },
  async (t) => {
    const h = await setupBrowser(t, {
      name: "durable-draft-apply",
      seed: { name: "Interrupted apply" },
      planningFixture: true,
    });
    const original = await h.api(`/projects/${h.initial.id}`);
    const proposal = await makeProposal(h);
    await editTitle(h.page, "Apply this candidate exactly once");
    await draftSaved(h.page);
    const draft = await currentDraft(h, proposal);
    const attempted = deferred();
    let acceptance;
    await h.page.route("**/planning/proposals/*/accept", async (route) => {
      acceptance = route.request().postDataJSON();
      attempted.resolve();
      return route.abort("failed");
    });
    await workspace(h.page)
      .getByRole("button", { name: "Apply changes", exact: true })
      .click();
    await attempted.promise;
    await h.page
      .getByRole("button", { name: "Retry apply", exact: true })
      .waitFor();
    assert.equal(
      (await h.api(proposalUrl(h, proposal) + "/drafts/" + draft.id)).draft
        .state,
      "applying",
    );
    assert.deepEqual(await h.api(`/projects/${h.initial.id}`), original);
    await h.context.close();
    await h.restart({ reload: false });
    const fresh = await isolatedPage(t, h);
    await openProposal(fresh.page);
    const committed = deferred();
    await fresh.page.route("**/planning/proposals/*/accept", async (route) => {
      assert.deepEqual(
        route.request().postDataJSON(),
        acceptance,
        "Recovered Apply uses the frozen request",
      );
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      committed.resolve();
      return route.abort("failed");
    });
    await fresh.page
      .getByRole("button", { name: "Retry apply", exact: true })
      .click();
    await committed.promise;
    const applied = await h.api(`/projects/${h.initial.id}`);
    assert.equal(applied.history.length, original.history.length + 1);
    assert.equal(
      applied.content.diagrams[0].nodes[0].title,
      "Apply this candidate exactly once",
    );
    await fresh.context.close();
    await h.restart({ reload: false });
    const after = await isolatedPage(t, h);
    await after.page
      .getByText("Apply this candidate exactly once", { exact: true })
      .waitFor();
    await h.api(proposalUrl(h, proposal) + "/accept", "POST", acceptance);
    assert.deepEqual(
      await h.api(`/projects/${h.initial.id}`),
      applied,
      "Repeating a committed Apply cannot add history or replace later content",
    );
    assert.equal(
      (await h.api(proposalUrl(h, proposal) + "/drafts/" + draft.id)).draft
        .state,
      "applied",
    );
  },
);

test(
  "discarded durable drafts remain tombstoned after restart and late save attempts",
  { timeout: 120000 },
  async (t) => {
    const h = await setupBrowser(t, {
      name: "durable-draft-discard",
      seed: { name: "Discard review" },
      planningFixture: true,
    });
    const original = await h.api(`/projects/${h.initial.id}`);
    const proposal = await makeProposal(h);
    await editTitle(h.page, "Discard this candidate deliberately");
    await draftSaved(h.page);
    const draft = await currentDraft(h, proposal);
    await workspace(h.page)
      .getByRole("button", { name: "Discard", exact: true })
      .click();
    await workspace(h.page).waitFor({ state: "hidden" });
    const discarded = (
      await h.api(proposalUrl(h, proposal) + "/drafts/" + draft.id)
    ).draft;
    assert.equal(discarded.state, "discarded");
    const late = await rawApi(
      h,
      proposalUrl(h, proposal) + "/drafts/" + draft.id,
      "PUT",
      {
        baseDraftRevision: draft.draftRevision,
        mutationId: crypto.randomUUID(),
        contentHash: draft.proposalHash,
        diagram: draft.candidate.diagrams.find((d) => d.id === draft.diagramId),
      },
    );
    assert.equal(
      late.status,
      409,
      "An old draft save cannot recreate discarded work",
    );
    await h.context.close();
    await h.restart({ reload: false });
    const fresh = await isolatedPage(t, h);
    await openChat(fresh.page);
    assert.equal(await workspace(fresh.page).isVisible(), false);
    const list = await h.api(proposalUrl(h, proposal) + "/drafts");
    assert.equal(list.defaultDraftId, null);
    assert.ok(list.drafts.every((row) => row.state === "discarded"));
    assert.equal(
      (await h.api(`/projects/${h.initial.id}/planning`)).proposals.find(
        (p) => p.id === proposal.id,
      ).state,
      "rejected",
    );
    assert.deepEqual(await h.api(`/projects/${h.initial.id}`), original);
  },
);


test("draft edits reconnect after a server restart without reloading the window", {timeout:60000}, async t => {
  const h=await setupBrowser(t,{name:"durable-draft-reconnect",seed:{name:"Reconnect"},planningFixture:true});
  const proposal=await makeProposal(h);
  await editTitle(h.page,"Candidate before restart");
  await until(async () => (await workspace(h.page).getByTestId("proposal-draft-state").textContent()).startsWith("Draft saved"));
  await h.restart({reload:false});
  await workspace(h.page).getByLabel("Title",{exact:true}).fill("Newer edit in the open window");
  await until(async () => {
    const list=await h.api(proposalUrl(h,proposal)+"/drafts");
    if(!list.defaultDraftId)return false;
    const {draft}=await h.api(proposalUrl(h,proposal)+"/drafts/"+list.defaultDraftId);
    return draft.candidate.diagrams[0].nodes[0].title==="Newer edit in the open window";
  });
  assert.equal(await workspace(h.page).getByLabel("Title",{exact:true}).inputValue(),"Newer edit in the open window");
});
