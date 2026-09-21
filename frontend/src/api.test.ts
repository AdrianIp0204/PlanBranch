import { afterEach, expect, it, vi } from "vitest";
import { api } from "./api";
afterEach(() => vi.unstubAllGlobals());
it("reconnects after server restart and replays only a rejected request with the same receipt", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({error:"Reload PlanBranch to reconnect to the local server."}),{status:403}))
    .mockResolvedValueOnce(new Response(JSON.stringify({token:"new-startup-token"})))
    .mockResolvedValueOnce(new Response(JSON.stringify({saved:true})));
  vi.stubGlobal("fetch",fetch);
  const body=JSON.stringify({mutationId:"captured-receipt",title:"Newest unsaved edit"});
  expect(await api("/draft",{method:"PUT",body})).toEqual({saved:true});
  expect(fetch.mock.calls[1][0]).toBe("/api/bootstrap");
  expect(fetch.mock.calls[2][1].body).toBe(body);
  expect(fetch.mock.calls[2][1].headers["X-FlowDesk-Token"]).toBe("new-startup-token");
});
it("does not replay unrelated failures or loop on repeated token rejection", async () => {
  const rejected=()=>new Response(JSON.stringify({error:"Reload PlanBranch to reconnect to the local server."}),{status:403});
  const fetch=vi.fn().mockResolvedValueOnce(rejected()).mockResolvedValueOnce(new Response(JSON.stringify({token:"new"}))).mockResolvedValueOnce(rejected());
  vi.stubGlobal("fetch",fetch);
  await expect(api("/draft")).rejects.toMatchObject({status:403});
  expect(fetch).toHaveBeenCalledTimes(3);
  fetch.mockClear().mockResolvedValueOnce(new Response(JSON.stringify({error:"Cross-site requests are not allowed."}),{status:403}));
  await expect(api("/draft")).rejects.toMatchObject({status:403});
  expect(fetch).toHaveBeenCalledOnce();
});
