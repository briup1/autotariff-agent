import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkbenchService, type WorkbenchOptions } from "./service.js";
import { WebError, safeError } from "./store.js";
import { PlanError } from "../closure/plans.js";
import type { PlanSelection } from "../closure/plan-types.js";

const MAX_BODY = 21 * 1024 * 1024;

// 启动仅回环工作台并提供来源、会话和显式发送接口。
export async function createWorkbenchServer(options: WorkbenchOptions = {}) {
  const service = new WorkbenchService(options);
  try { await service.initialize(); }
  catch (error) { await service.close(); throw error; }
  const server = createServer((request, response) => { void handle(request, response); });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  // 校验本机请求后分派 API；导入不等于发送执行要求。
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const host = request.headers.host;
      if (!host) throw new WebError(403, "仅允许本机访问。");
      const address = server.address();
      const port = address && typeof address !== "string" ? address.port : 3000;
      const permitted = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
      if (!permitted.has(host)) throw new WebError(403, "请求主机不受信任，请使用本机工作台地址。");
      if (request.headers.origin && request.headers.origin !== `http://${host}`) throw new WebError(403, "不允许跨来源请求。");
      if (request.headers["sec-fetch-site"] === "cross-site") throw new WebError(403, "不允许跨站请求。");
      const url = new URL(request.url ?? "/", `http://${host}`), path = url.pathname;
      if (request.method === "GET") {
        if (path === "/api/bootstrap") return json(response, 200, await service.bootstrap());
        if (path === "/api/plans") return json(response, 200, { plans: service.plans.list() });
        if (path === "/api/plans/archive-options") return json(response, 200, { contracts: await service.planArchiveOptions() });
        const versionOptions = path.match(/^\/api\/plans\/([\w-]+)\/version-options$/);
        if (versionOptions) return json(response,200,{contracts:await service.planVersionOptions(versionOptions[1])});
        const sourcePlans = path.match(/^\/api\/sources\/([\w-]+)\/plans$/);
        if (sourcePlans) return json(response,200,await service.availablePlanMatches(sourcePlans[1]));
        const plan = path.match(/^\/api\/plans\/([\w-]+)$/);
        if (plan) {
          const value = service.plans.get(plan[1]);
          return json(response, 200, { plan: value, version: service.plans.version(value.currentVersionId), versions:service.plans.versions(value.planId) });
        }
        const conversation = path.match(/^\/api\/conversations\/([\w-]+)$/);
        if (conversation) return json(response, 200, await service.conversation(conversation[1]));
        const run = path.match(/^\/api\/runs\/([\w-]+)$/);
        if (run) return json(response, 200, await service.projection.detail(run[1], url.searchParams.get("attempt") ?? undefined, integer(url.searchParams.get("offset"), 0, 0, 1000000), integer(url.searchParams.get("limit"), 50, 1, 200)));
        if (path === "/api/artifacts") {
          const runId = url.searchParams.get("runId") ?? "", artifactPath = url.searchParams.get("path") ?? "";
          if (url.searchParams.get("download") !== "1") return json(response, 200, await service.projection.content(runId, artifactPath));
          const { bytes } = await service.projection.artifact(runId, artifactPath);
          response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(basename(artifactPath))}`, "Content-Length": bytes.length });
          response.end(bytes); return;
        }
        const test = path.match(/^\/api\/tests\/([\w-]+)$/);
        if (test) return json(response, 200, await service.projection.test(test[1]));
        const assets: Record<string, [string, string]> = { "/": ["index.html", "text/html; charset=utf-8"], "/index.html": ["index.html", "text/html; charset=utf-8"], "/app.js": ["app.js", "text/javascript; charset=utf-8"], "/styles.css": ["styles.css", "text/css; charset=utf-8"] };
        if (assets[path]) {
          const [name, type] = assets[path];
          const bytes = await readFile(resolve(service.root, "web", name));
          response.writeHead(200, { "Content-Type": type, "Content-Length": bytes.length }); response.end(bytes); return;
        }
      } else if (request.method === "POST") {
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) throw new WebError(415, "请求必须使用 application/json。");
        const body = await readBody(request);
        const planVersion = path.match(/^\/api\/plans\/([\w-]+)\/versions$/);
        if (planVersion) return json(response,201,await service.createPlanVersion(planVersion[1],{
          requestId:string(body,"requestId",128),requirementsDigest:string(body,"requirementsDigest",64),contractSha256:string(body,"contractSha256",64),
          sourceId:string(body,"sourceId",180),expectedCurrentVersionId:string(body,"expectedCurrentVersionId",128),confirmContract:body.confirmContract === true,
        }));
        if (path === "/api/plans") return json(response, 201, await service.archivePlan({
          requestId: string(body, "requestId", 128), requirementsDigest: string(body, "requirementsDigest", 64),
          name: string(body, "name", 160), supplier: string(body, "supplier", 160), docType: string(body, "docType", 160),
          ...(body.sourceSignature === undefined ? {} : { sourceSignature: string(body, "sourceSignature", 64) }),
        }));
        const planAction = path.match(/^\/api\/plans\/([\w-]+)\/(rename|deactivate|restore)$/);
        if (planAction) return json(response, 200, planAction[2] === "rename"
          ? service.plans.rename(planAction[1], string(body, "name", 160))
          : service.plans.setInactive(planAction[1], planAction[2] === "deactivate"));
        if (path === "/api/conversations") return json(response, 201, await service.create(string(body, "sourceId", 180), optionalString(body, "title", 160),planSelection(body)));
        const message = path.match(/^\/api\/conversations\/([\w-]+)\/messages$/);
        if (message) {
          const requestId = string(body, "requestId", 128);
          if (!/^[\w-]+$/.test(requestId)) throw new WebError(400, "请求标识无效。");
          return json(response, 202, await service.send(message[1], requestId, string(body, "content", 16000),planSelection(body)));
        }
        if (path === "/api/uploads") return json(response, 201, await service.upload(string(body, "name", 180), string(body, "base64", 20 * 1024 * 1024), optionalString(body, "requirementsName", 180), optionalRequirementsText(body)));
        if (path === "/api/contracts/approve") {
          const runId = string(body, "runId", 128);
          const digestValue = string(body, "requirementsDigest", 64);
          const contractSha256 = string(body, "contractSha256", 64);
          if (!/^[\w-]+$/.test(runId) || !/^[a-f0-9]{64}$/.test(digestValue) || !/^[a-f0-9]{64}$/.test(contractSha256)) throw new WebError(400, "契约运行或摘要标识无效。");
          const approver = body.approver === undefined ? "local-user" : string(body, "approver", 80);
          return json(response, 200, await service.approveContract(runId, digestValue, contractSha256, approver));
        }
      }
      throw new WebError(404, "页面或接口不存在。");
    } catch (error) {
      if (!response.headersSent) json(response, error instanceof WebError || error instanceof PlanError ? error.status : 500,
        error instanceof PlanError ? { error: error.message, code: error.code } : { error: safeError(error) });
      else response.end();
    }
  }
  return {
    server, service,
    listen: (port = Number(process.env.PORT ?? "3000")): Promise<string> => new Promise((done, reject) => {
      if (!Number.isInteger(port) || port < 0 || port > 65535) { reject(new Error("PORT must be a valid local port")); return; }
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.removeListener("error", reject);
        const address = server.address();
        done(`http://127.0.0.1:${typeof address === "object" && address ? address.port : port}`);
      });
    }),
    close: async (): Promise<void> => {
      if (server.listening) await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
      await service.close();
    },
  };
}

function planSelection(body: Record<string,unknown>): PlanSelection | undefined {
  if (body.planSelection === undefined) return undefined;
  if (!body.planSelection || typeof body.planSelection !== "object" || Array.isArray(body.planSelection)) throw new WebError(400,"方案选择无效。");
  const value = body.planSelection as Record<string,unknown>;
  const selection = {planId:string(value,"planId",128),planVersionId:string(value,"planVersionId",128),planUpdatedAt:string(value,"planUpdatedAt",40),
    sourceSignature:string(value,"sourceSignature",64),sourceSha256:string(value,"sourceSha256",64)};
  if (!/^[a-f0-9]{64}$/.test(selection.sourceSignature) || !/^[a-f0-9]{64}$/.test(selection.sourceSha256)) throw new WebError(400,"方案结构签名无效。");
  return selection;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}
async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (Number(request.headers["content-length"] ?? 0) > MAX_BODY) throw new WebError(413, "上传数据超过大小限制。");
  const chunks: Buffer[] = []; let size = 0;
  for await (const part of request) {
    const chunk = Buffer.from(part); size += chunk.length;
    if (size > MAX_BODY) throw new WebError(413, "上传数据超过大小限制。");
    chunks.push(chunk);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new WebError(400, "请求必须是有效的 JSON 对象。"); }
}
function string(body: Record<string, unknown>, key: string, maximum: number): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim() || value.length > maximum) throw new WebError(400, `${key} 不能为空且不能超过 ${maximum} 字符。`);
  return value;
}
// 可选说明允许空白表示未附；仍校验类型、大小和非法文本。
function optionalRequirementsText(body: Record<string, unknown>): string | undefined {
  const value = body.requirementsText;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || Buffer.byteLength(value) > 64 * 1024 || value.includes("\0")) throw new WebError(400, "说明必须是 64 KiB 以内的文本。");
  return value;
}
function optionalString(body: Record<string, unknown>, key: string, maximum: number): string | undefined {
  return body[key] === undefined ? undefined : string(body, key, maximum);
}
function integer(value: string | null, fallback: number, minimum: number, maximum: number): number {
  if (value === null) return fallback;
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < minimum || number > maximum) throw new WebError(400, "分页参数无效。");
  return number;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createWorkbenchServer();
  try { console.log(`AutoTariff Agent 工作台 ${await app.listen()}`); }
  catch (error) { await app.close(); throw error; }
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void app.close().then(() => process.exit(0)); });
}
