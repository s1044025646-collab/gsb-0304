import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { solveKnapsack, KnapsackError, Item } from "../src/knapsack.js";
import { Store } from "../src/db.js";
import { KnapsackService } from "../src/service.js";

// 独立枚举全部子集，返回 [最大价值, 方案数, 字典序最小向量]
function bruteForce(items: Item[], capacity: number): [number, bigint, number[]] {
  const sorted = [...items].sort((a, b) => a.id - b.id);
  const n = sorted.length;
  let best = -1;
  let count = 0n;
  let bestVec: number[] = new Array(n).fill(0);
  for (let mask = 0; mask < 1 << n; mask++) {
    let w = 0;
    let v = 0;
    const vec: number[] = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) {
        w += sorted[i].weight;
        v += sorted[i].value;
        vec[i] = 1;
      }
    }
    if (w > capacity) continue;
    if (v > best) {
      best = v;
      count = 1n;
      bestVec = vec;
    } else if (v === best) {
      count += 1n;
      for (let i = 0; i < n; i++) {
        if (vec[i] !== bestVec[i]) {
          if (vec[i] < bestVec[i]) bestVec = vec;
          break;
        }
      }
    }
  }
  return [best, count, bestVec];
}

function randInt(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("经典示例: (2,3),(3,4),(4,5) 容量 5 -> 价值 7, 选 {1,2}", () => {
  const r = solveKnapsack(
    [
      { id: 1, weight: 2, value: 3 },
      { id: 2, weight: 3, value: 4 },
      { id: 3, weight: 4, value: 5 },
    ],
    5,
  );
  assert.equal(r.bestValue, 7);
  assert.equal(r.totalWeight, 5);
  assert.deepEqual(r.selectedIds, [1, 2]);
  assert.equal(r.count, "1");
});

test("同重量同价值不同编号: 方案数增加", () => {
  const r = solveKnapsack(
    [
      { id: 1, weight: 2, value: 3 },
      { id: 2, weight: 3, value: 4 },
      { id: 3, weight: 4, value: 5 },
      { id: 4, weight: 3, value: 4 },
    ],
    5,
  );
  assert.equal(r.bestValue, 7);
  assert.equal(r.count, "2"); // {1,2} 与 {1,4}
  assert.deepEqual(r.selectedIds, [1, 4]); // 向量 [1,0,0,1] 字典序小于 [1,1,0,0]
});

test("零价值物品参与平局计数", () => {
  const r = solveKnapsack(
    [
      { id: 1, weight: 2, value: 3 },
      { id: 2, weight: 3, value: 4 },
      { id: 5, weight: 1, value: 0 },
    ],
    6,
  );
  assert.equal(r.bestValue, 7);
  // {1,2} 与 {1,2,5} 都达到 7
  assert.equal(r.count, "2");
  assert.deepEqual(r.selectedIds, [1, 2]); // 展示向量 [1,1,0] 字典序更小
});

test("空物品集: 只有空集", () => {
  const r = solveKnapsack([], 10);
  assert.equal(r.bestValue, 0);
  assert.equal(r.count, "1");
  assert.deepEqual(r.selection, []);
});

test("零容量: 只有空集", () => {
  const r = solveKnapsack([{ id: 1, weight: 1, value: 5 }], 0);
  assert.equal(r.bestValue, 0);
  assert.equal(r.count, "1");
  assert.deepEqual(r.selectedIds, []);
});

test("全部装不下", () => {
  const r = solveKnapsack(
    [
      { id: 1, weight: 10, value: 5 },
      { id: 2, weight: 20, value: 9 },
    ],
    5,
  );
  assert.equal(r.bestValue, 0);
  assert.equal(r.count, "1");
});

test("恰好满容量与容量有余", () => {
  const items = [
    { id: 1, weight: 2, value: 3 },
    { id: 2, weight: 3, value: 4 },
  ];
  const exact = solveKnapsack(items, 5);
  assert.equal(exact.totalWeight, 5);
  const spare = solveKnapsack(items, 100);
  assert.equal(spare.bestValue, 7);
  assert.equal(spare.totalWeight, 5);
});

test("同值不同重量: 计数按编号子集", () => {
  const r = solveKnapsack(
    [
      { id: 1, weight: 1, value: 5 },
      { id: 2, weight: 2, value: 5 },
    ],
    2,
  );
  assert.equal(r.bestValue, 5);
  assert.equal(r.count, "2"); // {1} 或 {2}
  assert.deepEqual(r.selectedIds, [2]); // 向量 [0,1] 字典序小于 [1,0]
});

test("大整数计数: 30 个 (1,1) 物品容量 15 -> C(30,15)", () => {
  const items = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, weight: 1, value: 1 }));
  const r = solveKnapsack(items, 15);
  assert.equal(r.bestValue, 15);
  assert.equal(r.count, "155117520");
  // 字典序最小向量: 前 15 个位置为 0，后 15 个为 1
  assert.deepEqual(r.selection, [...Array(15).fill(0), ...Array(15).fill(1)]);
});

test("大整数计数: 60 个 (1,1) 容量 30 -> C(60,30)", () => {
  const items = Array.from({ length: 60 }, (_, i) => ({ id: i + 1, weight: 1, value: 1 }));
  const r = solveKnapsack(items, 30);
  assert.equal(r.count, "118264581564861424");
});

test("随机小规模与枚举逐一核对 (价值/计数/规范向量)", () => {
  const rng = mulberry32(42);
  for (let t = 0; t < 60; t++) {
    const n = randInt(rng, 0, 10);
    const items: Item[] = [];
    for (let i = 0; i < n; i++) {
      items.push({
        id: i + 1,
        weight: randInt(rng, 1, 8),
        value: randInt(rng, 0, 10),
      });
    }
    const capacity = randInt(rng, 0, 20);
    const [best, count, vec] = bruteForce(items, capacity);
    const r = solveKnapsack(items, capacity);
    assert.equal(r.bestValue, best, `价值不符 case=${t}`);
    assert.equal(BigInt(r.count), count, `计数不符 case=${t}`);
    assert.deepEqual(r.selection, vec, `向量不符 case=${t}`);
  }
});

test("输入顺序不影响计数与所选集合", () => {
  const items = [
    { id: 3, weight: 4, value: 5 },
    { id: 1, weight: 2, value: 3 },
    { id: 4, weight: 3, value: 4 },
    { id: 2, weight: 3, value: 4 },
  ];
  const a = solveKnapsack(items, 5);
  const b = solveKnapsack([...items].reverse(), 5);
  assert.equal(a.count, b.count);
  assert.deepEqual(a.selection, b.selection);
  assert.deepEqual(a.selectedIds, b.selectedIds);
});

test("容量增加时最优价值不下降", () => {
  const rng = mulberry32(7);
  const items: Item[] = Array.from({ length: 12 }, (_, i) => ({
    id: i + 1,
    weight: randInt(rng, 1, 6),
    value: randInt(rng, 0, 9),
  }));
  let prev = -1;
  for (let c = 0; c <= 30; c++) {
    const v = solveKnapsack(items, c).bestValue;
    assert.ok(v >= prev, `容量 ${c} 价值 ${v} < ${prev}`);
    prev = v;
  }
});

test("参数校验: 重复编号/负价值/零重量/非整数容量/超限", () => {
  assert.throws(() => solveKnapsack([{ id: 1, weight: 1, value: 1 }, { id: 1, weight: 2, value: 2 }], 5), (e: unknown) => e instanceof KnapsackError && e.code === "DUPLICATE_ID");
  assert.throws(() => solveKnapsack([{ id: 1, weight: 1, value: -1 }], 5), (e: unknown) => e instanceof KnapsackError && e.code === "NEGATIVE_VALUE");
  assert.throws(() => solveKnapsack([{ id: 1, weight: 0, value: 1 }], 5), (e: unknown) => e instanceof KnapsackError && e.code === "ZERO_WEIGHT");
  assert.throws(() => solveKnapsack([], 2.5), (e: unknown) => e instanceof KnapsackError && e.code === "NON_INTEGER_CAPACITY");
  assert.throws(
    () => solveKnapsack([{ id: 1, weight: 1, value: 1 }], 100, { maxItems: 10, maxCapacity: 1000, maxWeight: 10, maxValue: 10, maxStates: 50 }),
    (e: unknown) => e instanceof KnapsackError && e.code === "LIMIT_EXCEEDED",
  );
});

test("持久化: 重启后报告与回溯仍可读取，快照不被覆盖", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "knapsack-test-"));
  try {
    const items = [
      { id: 1, weight: 2, value: 3 },
      { id: 2, weight: 3, value: 4 },
      { id: 3, weight: 4, value: 5 },
    ];
    let snapshotId = 0;
    {
      const store = new Store(dir);
      const svc = new KnapsackService(store);
      const v = svc.importItems(items, "demo");
      const r = svc.solve(v.id, 5);
      snapshotId = r.snapshotId;
      store.close();
    }
    // 模拟重启：重新打开同一数据目录
    {
      const store = new Store(dir);
      const svc = new KnapsackService(store);
      const ex = svc.explain(snapshotId);
      assert.equal(ex.result.bestValue, 7);
      assert.equal(ex.trace.length, 3);
      assert.equal(ex.algoVersion, "dp-01knapsack/1.0.0");
      // 导入新物品版本不影响旧快照
      svc.importItems([{ id: 9, weight: 1, value: 1 }], "other");
      const again = svc.explain(snapshotId);
      assert.equal(again.result.bestValue, 7);
      const verify = svc.verify(snapshotId);
      assert.ok(verify.weightMatches && verify.valueMatches && verify.fitsCapacity);
      store.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("对照模式: 逐项状态，部分失败不误报", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "knapsack-test-"));
  try {
    const store = new Store(dir);
    const svc = new KnapsackService(store, { maxItems: 10, maxCapacity: 1000, maxWeight: 100, maxValue: 100, maxStates: 1000 });
    const v = svc.importItems([{ id: 1, weight: 2, value: 3 }], "");
    const r = svc.compare(v.id, [5, 999]);
    assert.equal(r.entries[0].status, "ok");
    assert.equal(r.entries[1].status, "error");
    assert.equal(r.entries[1].error?.code, "LIMIT_EXCEEDED");
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("未知版本报错", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "knapsack-test-"));
  try {
    const store = new Store(dir);
    const svc = new KnapsackService(store);
    assert.throws(() => svc.solve(999, 5), (e: unknown) => e instanceof KnapsackError && e.code === "UNKNOWN_VERSION");
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
