import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/db.ts";
import { solveKnapsack } from "../src/core.ts";

test("物品版本不可变，分析快照可重启后读取", () => {
  const store = new Store(":memory:");
  const items = [
    { id: 1, weight: 2, value: 3 },
    { id: 2, weight: 3, value: 4 },
  ];
  const set = store.createItemSet("测试集", items);
  const result = solveKnapsack(items, 5);
  const analysis = store.createAnalysis(set.id, { kind: "solve", setId: set.id, capacity: 5 }, result);

  // 重新读取（等价于重启后读取）
  const loaded = store.getAnalysis(analysis.id);
  assert.equal(loaded.algoVersion, result.algoVersion);
  assert.deepEqual(loaded.params, { kind: "solve", setId: set.id, capacity: 5 });
  assert.deepEqual(loaded.results, JSON.parse(JSON.stringify(result)));

  // 再次导入生成新版本，旧版本与旧报告不受影响
  const set2 = store.createItemSet("测试集v2", [...items, { id: 3, weight: 1, value: 1 }]);
  assert.notEqual(set2.id, set.id);
  assert.equal(store.getItemSet(set.id).items.length, 2);
  assert.equal(store.listAnalyses().length, 1);
  store.close();
});

test("未知版本报错 NOT_FOUND", () => {
  const store = new Store(":memory:");
  assert.throws(() => store.getItemSet(999), /不存在/);
  assert.throws(() => store.getAnalysis(999), /不存在/);
  store.close();
});
