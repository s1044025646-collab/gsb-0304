export const ALGO_VERSION = "dp-01knapsack/1.0.0";

export interface Item {
  id: number;
  weight: number;
  value: number;
}

export interface Limits {
  maxItems: number;
  maxCapacity: number;
  maxWeight: number;
  maxValue: number;
  maxStates: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxItems: 5000,
  maxCapacity: 200000,
  maxWeight: 1000000,
  maxValue: 1000000,
  // (n+1)*(C+1) 状态表规模上限，超出即拒绝，避免无限占用内存
  maxStates: 5_000_000,
};

export class KnapsackError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "KnapsackError";
  }
}

export interface TraceStep {
  index: number;
  itemId: number;
  weight: number;
  value: number;
  remainingCapacity: number;
  takeValue: number | null; // null 表示装不下
  takeCount: string | null;
  skipValue: number;
  skipCount: string;
  decision: "take" | "skip";
  reason: string;
}

export interface SolveResult {
  algoVersion: string;
  capacity: number;
  bestValue: number;
  totalWeight: number;
  count: string; // 达到最优价值的不同编号子集数量，十进制字符串
  selection: number[]; // 按编号排序的 0/1 向量，同值时取字典序最小
  selectedIds: number[];
  stateCount: number;
  trace: TraceStep[];
}

function assertSafeInteger(x: number, code: string, what: string): void {
  if (typeof x !== "number" || !Number.isInteger(x)) {
    throw new KnapsackError(code, `${what} 必须是整数，收到: ${String(x)}`);
  }
}

export function validateItems(items: Item[], limits: Limits = DEFAULT_LIMITS): Item[] {
  if (!Array.isArray(items)) {
    throw new KnapsackError("VALIDATION", "物品列表必须是数组");
  }
  if (items.length > limits.maxItems) {
    throw new KnapsackError(
      "LIMIT_EXCEEDED",
      `物品数 ${items.length} 超过上限 ${limits.maxItems}`,
    );
  }
  const seen = new Set<number>();
  let totalValue = 0;
  for (const it of items) {
    assertSafeInteger(it.id, "VALIDATION", "物品编号");
    assertSafeInteger(it.weight, "VALIDATION", `物品 ${it.id} 的重量`);
    assertSafeInteger(it.value, "VALIDATION", `物品 ${it.id} 的价值`);
    if (seen.has(it.id)) {
      throw new KnapsackError("DUPLICATE_ID", `物品编号重复: ${it.id}`);
    }
    seen.add(it.id);
    if (it.weight <= 0) {
      throw new KnapsackError("ZERO_WEIGHT", `物品 ${it.id} 的重量必须为正整数`);
    }
    if (it.value < 0) {
      throw new KnapsackError("NEGATIVE_VALUE", `物品 ${it.id} 的价值不能为负`);
    }
    if (it.weight > limits.maxWeight) {
      throw new KnapsackError("LIMIT_EXCEEDED", `物品 ${it.id} 的重量超过上限 ${limits.maxWeight}`);
    }
    if (it.value > limits.maxValue) {
      throw new KnapsackError("LIMIT_EXCEEDED", `物品 ${it.id} 的价值超过上限 ${limits.maxValue}`);
    }
    totalValue += it.value;
  }
  if (totalValue > Number.MAX_SAFE_INTEGER) {
    throw new KnapsackError("LIMIT_EXCEEDED", "价值总和超过安全整数范围");
  }
  // 输入顺序不影响结果：统一按编号排序
  return [...items].sort((a, b) => a.id - b.id);
}

export function validateCapacity(capacity: number, limits: Limits = DEFAULT_LIMITS): void {
  assertSafeInteger(capacity, "NON_INTEGER_CAPACITY", "容量");
  if (capacity < 0) {
    throw new KnapsackError("VALIDATION", "容量不能为负");
  }
  if (capacity > limits.maxCapacity) {
    throw new KnapsackError("LIMIT_EXCEEDED", `容量 ${capacity} 超过上限 ${limits.maxCapacity}`);
  }
}

export function solveKnapsack(
  rawItems: Item[],
  capacity: number,
  limits: Limits = DEFAULT_LIMITS,
): SolveResult {
  const items = validateItems(rawItems, limits);
  validateCapacity(capacity, limits);
  const n = items.length;
  const C = capacity;
  const states = (n + 1) * (C + 1);
  if (states > limits.maxStates) {
    throw new KnapsackError(
      "LIMIT_EXCEEDED",
      `状态表规模 ${states} 超过上限 ${limits.maxStates}（物品 ${n}，容量 ${C}）`,
    );
  }

  // 第一步：价值 DP。V[i*(C+1)+w] = 仅使用第 i..n-1 件物品、容量 w 时的最大价值。
  const width = C + 1;
  const V = new Float64Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    const wi = items[i].weight;
    const vi = items[i].value;
    const row = i * width;
    const next = (i + 1) * width;
    for (let w = 0; w <= C; w++) {
      const skip = V[next + w];
      const take = wi <= w ? V[next + w - wi] + vi : -Infinity;
      V[row + w] = take > skip ? take : skip;
    }
  }

  // 第二步：按字典序最小（0<1，同值优先跳过）回溯，得到展示用选择向量与路径。
  const selection = new Array<number>(n).fill(0);
  const pathCells: number[] = []; // 路径上每步的剩余容量
  {
    let w = C;
    for (let i = 0; i < n; i++) {
      pathCells.push(w);
      const wi = items[i].weight;
      const vi = items[i].value;
      const skip = V[(i + 1) * width + w];
      const take = wi <= w ? V[(i + 1) * width + w - wi] + vi : -Infinity;
      if (take > skip) {
        selection[i] = 1;
        w -= wi;
      }
      // take === skip 时选择跳过：位置 i 上 0 < 1，向量字典序更小
    }
  }

  // 第三步：计数 DP（只保留两行 BigInt，并在路径经过的格子记录计数用于解释）。
  // cnt[w] = 第 i..n-1 件物品、容量 w 下达到 V[i][w] 的不同编号子集数。
  const traceCounts: (bigint | null)[] = new Array(n).fill(null);
  const traceTakeCounts: (bigint | null)[] = new Array(n).fill(null);
  const traceSkipCounts: (bigint | null)[] = new Array(n).fill(null);
  let next = new Array<bigint>(width).fill(1n); // 第 n 行：空集唯一
  let bestCount = 1n;
  for (let i = n - 1; i >= 0; i--) {
    const wi = items[i].weight;
    const cur = new Array<bigint>(width);
    for (let w = 0; w <= C; w++) {
      const skipV = V[(i + 1) * width + w];
      const takeV = wi <= w ? V[(i + 1) * width + w - wi] + items[i].value : -Infinity;
      let c = 0n;
      if (takeV >= skipV && takeV !== -Infinity) c += next[w - wi];
      if (skipV >= takeV) c += next[w];
      cur[w] = c;
    }
    const pw = pathCells[i];
    traceCounts[i] = cur[pw];
    const skipV = V[(i + 1) * width + pw];
    const takeV = wi <= pw ? V[(i + 1) * width + pw - wi] + items[i].value : -Infinity;
    traceTakeCounts[i] = takeV !== -Infinity && takeV >= skipV ? next[pw - wi] : takeV === -Infinity ? null : 0n;
    traceSkipCounts[i] = skipV >= takeV ? next[pw] : 0n;
    if (i === 0) bestCount = cur[C];
    next = cur;
  }

  // 汇总结果与回溯解释
  let totalWeight = 0;
  let bestValue = 0;
  const selectedIds: number[] = [];
  for (let i = 0; i < n; i++) {
    if (selection[i] === 1) {
      totalWeight += items[i].weight;
      bestValue += items[i].value;
      selectedIds.push(items[i].id);
    }
  }

  const trace: TraceStep[] = [];
  {
    let w = C;
    for (let i = 0; i < n; i++) {
      const wi = items[i].weight;
      const vi = items[i].value;
      const skipV = V[(i + 1) * width + w];
      const takeV = wi <= w ? V[(i + 1) * width + w - wi] + vi : null;
      const decision: "take" | "skip" = selection[i] === 1 ? "take" : "skip";
      let reason: string;
      if (takeV === null) {
        reason = `剩余容量 ${w} 装不下（重 ${wi}），只能跳过`;
      } else if (takeV > skipV) {
        reason = `保留价值 ${takeV} > 跳过价值 ${skipV}，选择保留`;
      } else if (takeV < skipV) {
        reason = `跳过价值 ${skipV} > 保留价值 ${takeV}，选择跳过`;
      } else {
        reason = `保留与跳过价值同为 ${skipV}，方案数相加；按字典序最小规则展示跳过`;
      }
      trace.push({
        index: i,
        itemId: items[i].id,
        weight: wi,
        value: vi,
        remainingCapacity: w,
        takeValue: takeV,
        takeCount: traceTakeCounts[i] === null ? null : traceTakeCounts[i]!.toString(),
        skipValue: skipV,
        skipCount: traceSkipCounts[i]!.toString(),
        decision,
        reason,
      });
      if (decision === "take") w -= wi;
    }
  }

  return {
    algoVersion: ALGO_VERSION,
    capacity: C,
    bestValue,
    totalWeight,
    count: bestCount.toString(),
    selection,
    selectedIds,
    stateCount: states,
    trace,
  };
}
