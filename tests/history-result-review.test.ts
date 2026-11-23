import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { expect, it } from "vitest";
import { PROJECT_ROOT } from "../src/closure/paths.js";

it("returns one 500 on a synthetic static read failure and serves the next request normally", async () => {
  const source = await readFile(resolve(PROJECT_ROOT, "scripts/history-result-review.mjs"), "utf8");
  let fail = true;
  let handler: (request: unknown, response: unknown) => void = () => {};
  const context = createContext({ URL, resolve, root: PROJECT_ROOT, log: "synthetic-log", appendFile: async () => {},
    readFile: async () => { if (fail) throw new Error("合成静态读取失败"); return "synthetic styles"; },
    createServer: (callback: typeof handler) => { handler = callback; return {}; } });
  runInContext(source.slice(source.indexOf("async function respond("), source.indexOf("server.listen(")), context);
  // 轻量响应替身保留重复发送响应头的失败语义，并等待异步错误处理完成。
  async function request() {
    const headers: number[] = [];
    let finish: (value: string) => void = () => {};
    const completed = new Promise<string>((resolve) => { finish = resolve; });
    handler({ url: "/styles.css", method: "GET" }, {
      writeHead(status: number) { if (headers.length) throw new Error("ERR_HTTP_HEADERS_SENT"); headers.push(status); },
      end(content: string) { finish(content); },
    });
    return { headers, body: await completed };
  }
  const failed = await request();
  expect(failed.headers).toEqual([500]);
  expect(failed.body).toContain("合成静态读取失败");
  fail = false;
  const recovered = await request();
  expect(recovered.headers).toEqual([200]);
  expect(recovered.body).toBe("synthetic styles");
});
