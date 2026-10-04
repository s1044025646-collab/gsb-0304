/**
 * 零一背包核心动态规划。
 *
 * 设计要点：
 * - 物品按编号升序排列，输入顺序不影响结果。
 * - 价值/重量/容量均为整数，价值用 Float64 精确表示（受 maxValue/maxItems 限制，远低于 2^53）。
 * - 方案计数使用 BigInt，输出十进制字符串；同值时计数相加。
 * - 展示集合采用“按编号排序的 0/1 向量字典序最小（0<1）”规则，只影响展示，不影响计数。
 */

export const ALGO_VERSION = "dp-01knapsack/1.0.0";

export interface Item {
  id: number;
  weight: number;
  value: number;
}

export interface Limits {
  maxItems: number;
  maxCapacity: number;
  /** 回溯用价值状态表 (n+1)*(W+1) 的最大格子数，超限拒绝。 */
  maxStates: number;
  maxWeight: number;
  maxValue: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxItems: 2000,
  maxCapacity: 200000,
  maxStates: 5_000_000,
  maxWeight: 1_000_000,
  maxValue: 1_000_000_000,
};

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "LIMIT_EXCEEDED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INTERNAL_ERROR";

export class KnapsackError extends Error {
  code: ErrorCode;
  details?: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function isInt(x: unknown): x is number {
  return typeof x === "number" && Number.isInteger(x);
}

export function validateItems(raw: unknown, limits: Limits = DEFAULT_LIMITS): Item[] {
  if (!Array.isArray(raw)) {
    throw new KnapsackError("VALIDATION_ERROR", "items 必须是数组");
  }
  if (raw.length === 0) {
    throw new KnapsackError("VALIDATION_ERROR", "items 不能为空");
  }
  if (raw.length > limits.maxItems) {
    throw new KnapsackError(
      "LIMIT_EXCEEDED",
      `物品数 ${raw.length} 超过上限 ${limits.maxItems}`,
      { maxItems: limits.maxItems },
    );
  }
  const seen = new Set<number>();
  const items: Item[] = [];
  for (const [index, entry] of raw.entries()) {
    const it = entry as Record<string, unknown>;
    if (it === null || typeof it !== "object") {
      throw new KnapsackError("VALIDATION_ERROR", `第 ${index} 个物品不是对象`);
    }
    if (!isInt(it.id)) {
      throw new KnapsackError("VALIDATION_ERROR", `第 ${index} 个物品 id 非整数`, { item: it });
    }
    if (!isInt(it.weight) || it.weight < 1) {
      throw new KnapsackError("VALIDATION_ERROR", `物品 ${it.id} 重量必须为正整数`, { item: it });
    }
    if (!isInt(it.value) || it.value < 0) {
      throw new KnapsackError("VALIDATION_ERROR", `物品 ${it.id} 价值必须为非负整数`, { item: it });
    }
    if (it.weight > limits.maxWeight) {
      throw new KnapsackError("LIMIT_EXCEEDED", `物品 ${it.id} 重量超过上限 ${limits.maxWeight}`);
    }
    if (it.value > limits.maxValue) {
      throw new KnapsackError("LIMIT_EXCEEDED", `物品 ${it.id} 价值超过上限 ${limits.maxValue}`);
    }
    if (seen.has(it.id)) {
      throw new KnapsackError("CONFLICT", `物品编号 ${it.id} 重复`);
    }
    seen.add(it.id);
    items.push({ id: it.id, weight: it.weight, value: it.value });
  }
  return items;
}

export function validateCapacity(raw: unknown, limits: Limits = DEFAULT_LIMITS): number {
  if (!isInt(raw) || raw < 0) {
    throw new KnapsackError("VALIDATION_ERROR", "容量必须为非负整数", { capacity: raw });
  }
  if (raw > limits.maxCapacity) {
    throw new KnapsackError(
      "LIMIT_EXCEEDED",
      `容量 ${raw} 超过上限 ${limits.maxCapacity}`,
      { maxCapacity: limits.maxCapacity },
    );
  }
  return raw;
}

export interface PathStep {
  itemId: number;
  weight: number;
  value: number;
  /** 决策时剩余容量 */
  capacityBefore: number;
  /** 跳过该物品可取得的最优值（由后缀表得到） */
  skipValue: number;
  /** 选中该物品可取得的最优值；容量不足时为 null */
  takeValue: number | null;
  decision: "take" | "skip";
  reason: string;
}

export interface SolveResult {
  algoVersion: string;
  capacity: number;
  itemCount: number;
  bestValue: number;
  /** 达到最优价值的不同编号子集数量（十进制字符串） */
  bestCount: string;
  /** 按编号升序的 0/1 选择向量，字典序最小（0<1） */
  vector: number[];
  selectedIds: number[];
  totalWeight: number;
  totalValue: number;
  /** 状态表规模 (n+1)*(W+1) */
  stateCount: number;
  /** 回溯路径上每件物品的保留/跳过候选与决策说明 */
  path: PathStep[];
}

export function solveKnapsack(
  rawItems: Item[],
  capacity: number,
  limits: Limits = DEFAULT_LIMITS,
): SolveResult {
  validateCapacity(capacity, limits);
  const items = [...rawItems].sort((a, b) => a.id - b.id);
  const n = items.length;
  const W = capacity;
  const states = (n + 1) * (W + 1);
  if (states > limits.maxStates) {
    throw new KnapsackError(
      "LIMIT_EXCEEDED",
      `状态表规模 ${states} 超过上限 ${limits.maxStates}，请减小物品数或容量`,
      { states, maxStates: limits.maxStates },
    );
  }

  // 1D 价值 + BigInt 计数。count[c] 初始为 1：仅空集一种方案。
  // 物品重量恒为正，倒序遍历保证每件至多选一次，空集不会被重复计数。
  const value = new Float64Array(W + 1);
  const count: bigint[] = new Array<bigint>(W + 1).fill(1n);
  for (const it of items) {
    for (let c = W; c >= it.weight; c--) {
      const cand = value[c - it.weight]! + it.value;
      if (cand > value[c]!) {
        value[c] = cand;
        count[c] = count[c - it.weight]!;
      } else if (cand === value[c]!) {
        // 同值合并：保留旧方案 + 加入“选该物品”的方案。
        count[c] = count[c]! + count[c - it.weight]!;
      }
    }
  }
  const bestValue = value[W]!;
  const bestCount = count[W]!;

  // 后缀价值表 S[i][c]：仅用物品 i..n-1、容量 c 时的最优值，用于规范回溯。
  const suffix: Float64Array[] = new Array<Float64Array>(n + 1);
  suffix[n] = new Float64Array(W + 1);
  for (let i = n - 1; i >= 0; i--) {
    const prev = suffix[i + 1]!;
    const row = new Float64Array(prev);
    const it = items[i]!;
    for (let c = it.weight; c <= W; c++) {
      const cand = prev[c - it.weight]! + it.value;
      if (cand > row[c]!) row[c] = cand;
    }
    suffix[i] = row;
  }

  // 规范展示：按编号升序逐件决定。能跳过就跳过（0<1），否则必须选。
  const vector: number[] = new Array<number>(n).fill(0);
  const path: PathStep[] = [];
  let c = W;
  let target = bestValue;
  for (let i = 0; i < n; i++) {
    const it = items[i]!;
    const skipValue = suffix[i + 1]![c]!;
    const takeValue = c >= it.weight ? suffix[i + 1]![c - it.weight]! + it.value : null;
    if (skipValue >= target) {
      vector[i] = 0;
      path.push({
        itemId: it.id, weight: it.weight, value: it.value, capacityBefore: c,
        skipValue, takeValue, decision: "skip",
        reason: "跳过该物品仍可达到剩余最优值，按字典序最小规则记 0",
      });
    } else {
      vector[i] = 1;
      path.push({
        itemId: it.id, weight: it.weight, value: it.value, capacityBefore: c,
        skipValue, takeValue, decision: "take",
        reason: "跳过后无法达到剩余最优值，必须选中该物品",
      });
      c -= it.weight;
      target -= it.value;
    }
  }

  const selectedIds = items.filter((_, i) => vector[i] === 1).map((it) => it.id);
  const totalWeight = items.reduce((s, it, i) => s + (vector[i] === 1 ? it.weight : 0), 0);
  const totalValue = items.reduce((s, it, i) => s + (vector[i] === 1 ? it.value : 0), 0);

  return {
    algoVersion: ALGO_VERSION,
    capacity: W,
    itemCount: n,
    bestValue,
    bestCount: bestCount.toString(10),
    vector,
    selectedIds,
    totalWeight,
    totalValue,
    stateCount: states,
    path,
  };
}

export interface CompareItemResult {
  capacity: number;
  status: "ok" | "error";
  result?: SolveResult;
  error?: { code: ErrorCode; message: string };
}

export interface CompareResult {
  algoVersion: string;
  status: "ok" | "partial" | "failed";
  summary: { total: number; ok: number; failed: number };
  results: CompareItemResult[];
}

/** 同一物品版本的多容量对照。逐项记录状态，部分失败不会误报为全部完成。 */
export function solveCompare(
  items: Item[],
  capacities: number[],
  limits: Limits = DEFAULT_LIMITS,
): CompareResult {
  const results: CompareItemResult[] = capacities.map((capacity) => {
    try {
      const cap = validateCapacity(capacity, limits);
      return { capacity, status: "ok" as const, result: solveKnapsack(items, cap, limits) };
    } catch (err) {
      if (err instanceof KnapsackError) {
        return { capacity, status: "error" as const, error: { code: err.code, message: err.message } };
      }
      throw err;
    }
  });
  const ok = results.filter((r) => r.status === "ok").length;
  const failed = results.length - ok;
  return {
    algoVersion: ALGO_VERSION,
    status: failed === 0 ? "ok" : ok === 0 ? "failed" : "partial",
    summary: { total: results.length, ok, failed },
    results,
  };
}
