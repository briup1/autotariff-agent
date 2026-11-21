import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { expect, it } from "vitest";
import { PROJECT_ROOT } from "../src/closure/paths.js";

it.each(["truncated", "malformed"])("keeps the same paid request identity after a %s success response", async (failure) => {
  const source = await readFile(resolve(PROJECT_ROOT, "web/app.js"), "utf8");
  const api = source.slice(source.indexOf("async function api("), source.indexOf("function markConnected("));
  const send = source.slice(source.indexOf("async function sendMessage("), source.indexOf("async function openArtifact("));
  const requests: Array<{ requestId: string; content: string }> = [];
  let pending: unknown = null;
  let sequence = 0;
  const input = { value: "同一条抽取要求" };
  const context = createContext({
    state: { selection: "c1", sending: false, notice: "", drafts: new Map(), conversation: { messages: [] } },
    crypto: { randomUUID: () => `request-${++sequence}` },
    $: (id: string) => id === "message-input" ? input : { disabled: false },
    isActive: () => false,
    pendingFor: () => pending,
    savePending: (_id: string, value: unknown) => { pending = value; },
    markConnected: () => {}, markDisconnected: () => {}, renderComposer: () => {}, renderMessages: () => {}, renderSidebar: () => {}, renderConversationHeader: () => {}, updateConversationSummary: () => {}, loadRun: async () => {},
    fetch: async (_path: string, options: { body: string }) => {
      requests.push(JSON.parse(options.body));
      return { ok: true, status: 202, json: async () => {
        if (requests.length === 1) {
          if (failure === "truncated") throw new TypeError("terminated after 202 headers");
          return {};
        }
        return { conversation: { id: "c1" }, runs: [], messages: [] };
      } };
    },
  });
  runInContext(api + send, context);
  await runInContext("sendMessage({preventDefault(){}})", context);
  expect(pending).toMatchObject({ requestId: "request-1", content: input.value });
  await runInContext("sendMessage({preventDefault(){}})", context);
  expect(requests.map((request) => request.requestId)).toEqual(["request-1", "request-1"]);
  expect(pending).toBeNull();
});
