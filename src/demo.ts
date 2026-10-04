import { solveKnapsack } from "./knapsack.js";

interface DemoItem {
  id: number;
  weight: number;
  value: number;
}

function show(title: string, items: DemoItem[], capacity: number): void {
  const r = solveKnapsack(items, capacity);
  console.log(`\n== ${title} ==`);
  console.log(`物品: ${items.map((i) => `#${i.id}(w=${i.weight},v=${i.value})`).join(" ")}  容量=${capacity}`);
  console.log(`最优价值=${r.bestValue} 总重=${r.totalWeight} 方案数=${r.count}`);
  console.log(`展示向量(按编号, 0<1 字典序最小): [${r.selection.join(",")}]  选中编号: [${r.selectedIds.join(",")}]`);
  for (const t of r.trace) {
    console.log(
      `  物品#${t.itemId} 剩余容量=${t.remainingCapacity} 保留值=${t.takeValue ?? "装不下"} 跳过值=${t.skipValue} -> ${t.decision === "take" ? "保留" : "跳过"} (${t.reason})`,
    );
  }
}

console.log("零一背包演示（算法版本 dp-01knapsack/1.0.0）");

show("经典三物品", [
  { id: 1, weight: 2, value: 3 },
  { id: 2, weight: 3, value: 4 },
  { id: 3, weight: 4, value: 5 },
], 5);

show("加入同重量同价值的不同编号物品 #4(w=3,v=4)", [
  { id: 1, weight: 2, value: 3 },
  { id: 2, weight: 3, value: 4 },
  { id: 3, weight: 4, value: 5 },
  { id: 4, weight: 3, value: 4 },
], 5);

show("零价值物品参与平局计数", [
  { id: 1, weight: 2, value: 3 },
  { id: 2, weight: 3, value: 4 },
  { id: 5, weight: 1, value: 0 },
], 5);

show(
  "大整数计数: 30 个相同物品(w=1,v=1) 容量 15",
  Array.from({ length: 30 }, (_, i) => ({ id: i + 1, weight: 1, value: 1 })),
  15,
);
