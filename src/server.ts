import * as http from "node:http";
import { KnapsackService } from "./service.js";
import { KnapsackError } from "./knapsack.js";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

function sendError(res: http.ServerResponse, e: unknown): void {
  if (e instanceof KnapsackError) {
    const status =
      e.code === "UNKNOWN_VERSION" || e.code === "UNKNOWN_SNAPSHOT" ? 404 : e.code === "LIMIT_EXCEEDED" ? 413 : 400;
    sendJson(res, status, { error: { code: e.code, message: e.message } });
  } else {
    sendJson(res, 500, { error: { code: "INTERNAL", message: String(e) } });
  }
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 5 * 1024 * 1024) {
      throw new KnapsackError("LIMIT_EXCEEDED", "请求体超过 5MB 限制");
    }
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  } catch {
    throw new KnapsackError("BAD_JSON", "请求体不是合法 JSON");
  }
}

function toInt(x: unknown, code: string, what: string): number {
  const n = typeof x === "string" && x.trim() !== "" ? Number(x) : x;
  if (typeof n !== "number" || !Number.isInteger(n)) {
    throw new KnapsackError(code, `${what} 必须是整数`);
  }
  return n as number;
}

export function createServer(service: KnapsackService): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";
    try {
      if (method === "GET" && path === "/api/limits") {
        return sendJson(res, 200, { algoVersion: "dp-01knapsack/1.0.0", limits: service.getLimits() });
      }
      if (method === "POST" && path === "/api/items") {
        const body = (await readBody(req)) as { items?: unknown; note?: unknown };
        if (!Array.isArray(body.items)) {
          throw new KnapsackError("VALIDATION", "缺少 items 数组");
        }
        const version = service.importItems(body.items as never, String(body.note ?? ""));
        return sendJson(res, 201, { versionId: version.id, itemCount: version.items.length, createdAt: version.createdAt });
      }
      if (method === "GET" && path === "/api/versions") {
        return sendJson(res, 200, { versions: service.versions() });
      }
      if (method === "POST" && path === "/api/solve") {
        const body = (await readBody(req)) as { versionId?: unknown; capacity?: unknown };
        const versionId = toInt(body.versionId, "VALIDATION", "versionId");
        const capacity = toInt(body.capacity, "NON_INTEGER_CAPACITY", "capacity");
        return sendJson(res, 200, service.solve(versionId, capacity));
      }
      if (method === "POST" && path === "/api/compare") {
        const body = (await readBody(req)) as { versionId?: unknown; capacities?: unknown };
        const versionId = toInt(body.versionId, "VALIDATION", "versionId");
        if (!Array.isArray(body.capacities)) {
          throw new KnapsackError("VALIDATION", "缺少 capacities 数组");
        }
        const capacities = body.capacities.map((c) => toInt(c, "NON_INTEGER_CAPACITY", "capacity"));
        return sendJson(res, 200, service.compare(versionId, capacities));
      }
      const explainMatch = path.match(/^\/api\/explain\/(\d+)$/);
      if (method === "GET" && explainMatch) {
        return sendJson(res, 200, service.explain(Number(explainMatch[1])));
      }
      const verifyMatch = path.match(/^\/api\/verify\/(\d+)$/);
      if (method === "GET" && verifyMatch) {
        return sendJson(res, 200, service.verify(Number(verifyMatch[1])));
      }
      const exportMatch = path.match(/^\/api\/export\/(\d+)$/);
      if (method === "GET" && exportMatch) {
        return sendJson(res, 200, service.exportSnapshot(Number(exportMatch[1])));
      }
      if (method === "GET" && path === "/api/history") {
        return sendJson(res, 200, { snapshots: service.history() });
      }
      return sendJson(res, 404, { error: { code: "NOT_FOUND", message: `未知路由: ${method} ${path}` } });
    } catch (e) {
      return sendError(res, e);
    }
  });
}

export function startServer(service: KnapsackService, port: number): Promise<number> {
  const server = createServer(service);
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    // port 传 0 时由系统分配空闲端口
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : port);
    });
  });
}
