import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_LIMITS,
  KnapsackError,
  solveCompare,
  solveKnapsack,
  validateItems,
  type Item,
} from "../src/core.ts";

/** 独立枚举全部子集，返回 { bestValue, bestCount, lexVector }。 */
function bruteForce(items: Item[], capacity: number) {
  const sorted = [...items].sort((a, b) => a.id - b.id);
  const n = sorted.length;
  let bestValue = -1;
  let bestCount = 0n;
  let bestVector: number[] = [];
  for (let mask = 0n; mask < (1n << BigInt(n)); mask++) {
    let w = 0;
    let v = 0;
    const vector: number[] = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) {
      if ((mask >> BigInt(i)) & 1n) {
        w += sorted[i]!.weight;
        v += sorted[i]!.value;
        vector[i] = 1;
      }
    }
    if (w > capacity) continue;
    if (v > bestValue) {
      bestValue = v;
      bestCount = 1n;
      bestVector = vector;
    } else if (v === bestValue) {
      bestCount += 1n;
      // 字典序最小（0<1）：逐位比较，先出现 0 的更小。
      for (let i = 0; i < n; i++) {
        if (vector[i]! < bestVector[i]!) { bestVector = vector; break; }
        if (vector[i]! > bestVector[i]!) break;
      }
    }
  }
  return { bestValue, bestCount, bestVector };
}

function randomItems(rng: () => number, n: number): Item[] {
  const items: Item[] = [];
  for (let i = 0; i < n; i++) {
    items.push({
      id: i + 1,
      weight: 1 + Math.floor(rng() * 6),
      value: Math.floor(rng() * 8), // 允许零价值
    });
  }
  return items;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("经典示例: (2,3),(3,4),(4,5) 容量 5 -> 价值 7，选 {1,2}", () => {
  const r = solveKnapsack(
    [
      { id: 1, weight: 2, value: 3 },
      { id: 2, weight: 3, value: 4 },
      { id: 3, weight: 4, value: 5 },
    ],
    5,
  );
  assert.equal(r.bestValue, 7);
  assert.equal(r.bestCount, "1");
  assert.deepEqual(r.selectedIds, [1, 2]);
  assert.deepEqual(r.vector, [1, 1, 0]);
  assert.equal(r.totalWeight, 5);
  assert.equal(r.totalValue, 7);
});

test("同重量同价值不同编号：方案数增加，展示集合不变", () => {
  const items = [
    { id: 1, weight: 2, value: 3 },
    { id: 2, weight: 3, value: 4 },
    { id: 3, weight: 4, value: 5 },
    { id: 4, weight: 3, value: 4 },
  ];
  const r = solveKnapsack(items, 5);
  assert.equal(r.bestValue, 7);
  assert.equal(r.bestCount, "2"); // {1,2} 与 {1,4}
  // 向量 [1,0,0,1] 字典序小于 [1,1,0,0]（0<1），故展示 {1,4}
  assert.deepEqual(r.selectedIds, [1, 4]);
  assert.deepEqual(r.vector, [1, 0, 0, 1]);
});

test("零价值物品产生额外最优子集", () => {
  const items = [
    { id: 1, weight: 2, value: 3 },
    { id: 2, weight: 3, value: 4 },
    { id: 3, weight: 1, value: 0 },
  ];
  const r = solveKnapsack(items, 6);
  assert.equal(r.bestValue, 7);
  assert.equal(r.bestCount, "2"); // {1,2} 与 {1,2,3}
  assert.deepEqual(r.vector, [1, 1, 0]); // 展示仍取字典序最小
});

test("容量 0 只有空集", () => {
  const r = solveKnapsack([{ id: 1, weight: 1, value: 5 }], 0);
  assert.equal(r.bestValue, 0);
  assert.equal(r.bestCount, "1");
  assert.deepEqual(r.vector, [0]);
  assert.deepEqual(r.selectedIds, []);
});

test("全部装不下：空集唯一", () => {
  const r = solveKnapsack(
    [
      { id: 1, weight: 10, value: 5 },
      { id: 2, weight: 20, value: 9 },
    ],
    5,
  );
  assert.equal(r.bestValue, 0);
  assert.equal(r.bestCount, "1");
  assert.deepEqual(r.selectedIds, []);
});

test("恰好满容量与容量有余", () => {
  const items = [
    { id: 1, weight: 2, value: 3 },
    { id: 2, weight: 3, value: 4 },
  ];
  const exact = solveKnapsack(items, 5);
  assert.equal(exact.totalWeight, 5);
  const slack = solveKnapsack(items, 100);
  assert.equal(slack.bestValue, 7);
  assert.equal(slack.totalWeight, 5);
  assert.ok(slack.totalWeight <= 100);
});

test("同值不同重量的平局", () => {
  const items = [
    { id: 1, weight: 2, value: 5 },
    { id: 2, weight: 3, value: 5 },
  ];
  const r = solveKnapsack(items, 3);
  assert.equal(r.bestValue, 5);
  assert.equal(r.bestCount, "2"); // {1} 或 {2}
  assert.deepEqual(r.vector, [0, 1]); // 字典序最小是 [0,1]
});

test("大量同类物品的大整数计数", () => {
  // 30 件完全相同 (w=1,v=1)，容量 30：唯一方案是全选 -> 1。
  const items: Item[] = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, weight: 1, value: 1 }));
  const full = solveKnapsack(items, 30);
  assert.equal(full.bestValue, 30);
  assert.equal(full.bestCount, "1");
  // 容量 15：最优是从 30 件选 15 件，C(30,15) = 155117520。
  const half = solveKnapsack(items, 15);
  assert.equal(half.bestValue, 15);
  assert.equal(half.bestCount, "155117520");
  // 60 件 (w=1,v=0)，任意容量：所有子集都是最优（价值 0），共 2^60。
  const zeros: Item[] = Array.from({ length: 60 }, (_, i) => ({ id: i + 1, weight: 1, value: 0 }));
  const zr = solveKnapsack(zeros, 60);
  assert.equal(zr.bestValue, 0);
  assert.equal(zr.bestCount, (2n ** 60n).toString());
});

test("输入顺序不影响计数与所选集合", () => {
  const a = [
    { id: 3, weight: 4, value: 5 },
    { id: 1, weight: 2, value: 3 },
    { id: 2, weight: 3, value: 4 },
  ];
  const b = [
    { id: 1, weight: 2, value: 3 },
    { id: 2, weight: 3, value: 4 },
    { id: 3, weight: 4, value: 5 },
  ];
  const ra = solveKnapsack(a, 5);
  const rb = solveKnapsack(b, 5);
  assert.equal(ra.bestCount, rb.bestCount);
  assert.deepEqual(ra.vector, rb.vector);
  assert.deepEqual(ra.selectedIds, rb.selectedIds);
});

test("随机小规模：与独立枚举逐一核对", () => {
  const rng = mulberry32(42);
  for (let trial = 0; trial < 200; trial++) {
    const n = 1 + Math.floor(rng() * 9);
    const items = randomItems(rng, n);
    const capacity = Math.floor(rng() * 20);
    const expected = bruteForce(items, capacity);
    const got = solveKnapsack(items, capacity);
    assert.equal(got.bestValue, expected.bestValue, `trial ${trial} value`);
    assert.equal(got.bestCount, expected.bestCount.toString(), `trial ${trial} count`);
    assert.deepEqual(got.vector, expected.bestVector, `trial ${trial} vector`);
    // 核验选中集合
    assert.equal(got.totalValue, got.bestValue);
    assert.ok(got.totalWeight <= capacity);
  }
});

test("容量增加时最优价值不下降", () => {
  const rng = mulberry32(7);
  const items = randomItems(rng, 12);
  let prev = -1;
  for (let c = 0; c <= 30; c++) {
    const r = solveKnapsack(items, c);
    assert.ok(r.bestValue >= prev, `capacity ${c}`);
    prev = r.bestValue;
  }
});

test("参数校验：重复编号/负价值/零重量/非整数容量", () => {
  assert.throws(() => validateItems([{ id: 1, weight: 1, value: 1 }, { id: 1, weight: 2, value: 2 }]),
    (e: unknown) => e instanceof KnapsackError && e.code === "CONFLICT");
  assert.throws(() => validateItems([{ id: 1, weight: 1, value: -1 }]),
    (e: unknown) => e instanceof KnapsackError && e.code === "VALIDATION_ERROR");
  assert.throws(() => validateItems([{ id: 1, weight: 0, value: 1 }]),
    (e: unknown) => e instanceof KnapsackError && e.code === "VALIDATION_ERROR");
  assert.throws(
    () => solveKnapsack([{ id: 1, weight: 1, value: 1 }], 2.5),
    /状态表规模|容量/,
  );
});

test("状态表超限明确拒绝", () => {
  const items: Item[] = [{ id: 1, weight: 1, value: 1 }];
  const tight = { ...DEFAULT_LIMITS, maxStates: 10 };
  assert.throws(
    () => solveKnapsack(items, 100, tight),
    (e: unknown) => e instanceof KnapsackError && e.code === "LIMIT_EXCEEDED",
  );
});

test("批量对照：逐项状态，部分失败不误报", () => {
  const items = [{ id: 1, weight: 2, value: 3 }];
  const compare = solveCompare(items, [3, -1, 5]);
  assert.equal(compare.status, "partial");
  assert.equal(compare.summary.ok, 2);
  assert.equal(compare.summary.failed, 1);
  assert.equal(compare.results[0]!.status, "ok");
  assert.equal(compare.results[1]!.status, "error");
  assert.equal(compare.results[1]!.error?.code, "VALIDATION_ERROR");
  const allBad = solveCompare(items, [-1]);
  assert.equal(allBad.status, "failed");
});
