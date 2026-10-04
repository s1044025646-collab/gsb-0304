/** 基于 node:http 的 JSON API 服务。 */
import http from "node:http";
import {
  DEFAULT_LIMITS,
  KnapsackError,
  solveCompare,
  solveKnapsack,
  validateCapacity,
  validateItems,
  type Limits,
} from "./core.ts";
import { Store } from "./db.ts";

export interface ServerOptions {
  port?: number;
  limits?: Limits;
  dbPath?: string;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

function sendError(res: http.ServerResponse, err: unknown): void {
  if (err instanceof KnapsackError) {
    const status =
      err.code === "NOT_FOUND" ? 404
      : err.code === "CONFLICT" ? 409
      : err.code === "LIMIT_EXCEEDED" ? 413
      : 400;
    sendJson(res, status, { error: { code: err.code, message: err.message, details: err.details ?? null } });
  } else {
    sendJson(res, 500, { error: { code: "INTERNAL_ERROR", message: String(err) } });
  }
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new KnapsackError("VALIDATION_ERROR", "请求体不是合法 JSON");
  }
}

/** 从快照中抽取回溯路径，生成中文解释。 */
function buildExplanation(analysis: { id: number; algoVersion: string; params: unknown; results: unknown }) {
  const params = analysis.params as { kind?: string; capacity?: number };
  const results = analysis.results as {
    path?: unknown[];
    bestValue?: number;
    bestCount?: string;
    results?: { capacity: number; status: string; result?: { path?: unknown[]; bestValue?: number; bestCount?: string } }[];
  };
  const text =
    "计数含义：bestCount 表示达到最优价值 bestValue 的不同物品编号子集数量；" +
    "重量价值相同但编号不同的物品视为不同选择。展示集合只是所有最优子集中" +
    "按编号排序 0/1 向量字典序最小（0<1）的一套，不影响计数。";
  if (params.kind === "solve") {
    return {
      analysisId: analysis.id,
      algoVersion: analysis.algoVersion,
      capacity: params.capacity,
      bestValue: results.bestValue,
      bestCount: results.bestCount,
      countMeaning: text,
      steps: results.path ?? [],
    };
  }
  return {
    analysisId: analysis.id,
    algoVersion: analysis.algoVersion,
    countMeaning: text,
    perCapacity: (results.results ?? []).map((r) => ({
      capacity: r.capacity,
      status: r.status,
      bestValue: r.result?.bestValue ?? null,
      bestCount: r.result?.bestCount ?? null,
      steps: r.result?.path ?? [],
    })),
  };
}

export function createServer(options: ServerOptions = {}): {
  server: http.Server;
  store: Store;
  start: () => Promise<number>;
} {
  const limits = options.limits ?? DEFAULT_LIMITS;
  const store = new Store(options.dbPath);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const method = req.method ?? "GET";
      const segments = url.pathname.split("/").filter(Boolean);

      if (method === "GET" && url.pathname === "/api/health") {
        sendJson(res, 200, { status: "ok", limits });
        return;
      }

      if (method === "GET" && url.pathname === "/api/limits") {
        sendJson(res, 200, { limits });
        return;
      }

      if (method === "POST" && url.pathname === "/api/item-sets") {
        const body = (await readBody(req)) as Record<string, unknown>;
        const items = validateItems(body.items, limits);
        const name = typeof body.name === "string" && body.name.length > 0 ? body.name : "未命名物品集";
        const created = store.createItemSet(name, items);
        sendJson(res, 201, { itemSet: created });
        return;
      }

      if (method === "GET" && url.pathname === "/api/item-sets") {
        sendJson(res, 200, { itemSets: store.listItemSets() });
        return;
      }

      if (method === "GET" && segments[0] === "api" && segments[1] === "item-sets" && segments[2]) {
        sendJson(res, 200, { itemSet: store.getItemSet(Number(segments[2])) });
        return;
      }

      if (method === "POST" && url.pathname === "/api/solve") {
        const body = (await readBody(req)) as Record<string, unknown>;
        const capacity = validateCapacity(body.capacity, limits);
        let items;
        let setId: number | null = null;
        if (body.setId !== undefined) {
          const set = store.getItemSet(Number(body.setId));
          items = set.items;
          setId = set.id;
        } else {
          items = validateItems(body.items, limits);
        }
        const result = solveKnapsack(items, capacity, limits);
        const analysis = store.createAnalysis(setId, { kind: "solve", setId, capacity }, result);
        sendJson(res, 200, { analysisId: analysis.id, result });
        return;
      }

      if (method === "POST" && url.pathname === "/api/compare") {
        const body = (await readBody(req)) as Record<string, unknown>;
        if (!Array.isArray(body.capacities) || body.capacities.length === 0) {
          throw new KnapsackError("VALIDATION_ERROR", "capacities 必须为非空数组");
        }
        let items;
        let setId: number | null = null;
        if (body.setId !== undefined) {
          const set = store.getItemSet(Number(body.setId));
          items = set.items;
          setId = set.id;
        } else {
          items = validateItems(body.items, limits);
        }
        const compare = solveCompare(items, body.capacities as number[], limits);
        const analysis = store.createAnalysis(
          setId,
          { kind: "compare", setId, capacities: body.capacities },
          compare,
        );
        const httpStatus = compare.status === "failed" ? 422 : 200;
        sendJson(res, httpStatus, { analysisId: analysis.id, compare });
        return;
      }

      if (method === "GET" && url.pathname === "/api/analyses") {
        sendJson(res, 200, { analyses: store.listAnalyses() });
        return;
      }

      if (
        method === "GET" && segments[0] === "api" && segments[1] === "analyses" &&
        segments[2] && segments[3] === "explain"
      ) {
        const analysis = store.getAnalysis(Number(segments[2]));
        sendJson(res, 200, buildExplanation(analysis));
        return;
      }

      if (
        method === "GET" && segments[0] === "api" && segments[1] === "analyses" &&
        segments[2] && segments[3] === "export"
      ) {
        const analysis = store.getAnalysis(Number(segments[2]));
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": `attachment; filename="analysis-${analysis.id}.json"`,
        });
        res.end(JSON.stringify(analysis, null, 2));
        return;
      }

      if (method === "GET" && segments[0] === "api" && segments[1] === "analyses" && segments[2]) {
        sendJson(res, 200, { analysis: store.getAnalysis(Number(segments[2])) });
        return;
      }

      sendJson(res, 404, { error: { code: "NOT_FOUND", message: `未知路由 ${method} ${url.pathname}` } });
    } catch (err) {
      sendError(res, err);
    }
  });

  return {
    server,
    store,
    start: () =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        // 默认端口 0：由操作系统分配空闲端口。
        server.listen(options.port ?? 0, "127.0.0.1", () => {
          const address = server.address();
          resolve(typeof address === "object" && address ? address.port : 0);
        });
      }),
  };
}
