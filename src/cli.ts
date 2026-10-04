/**
 * 命令行入口。
 *
 * 用法：
 *   node src/cli.ts serve [--port 3000] [--db path]
 *   node src/cli.ts import <items.json> [--name 名称]
 *   node src/cli.ts solve (--set <id> | --items <items.json>) --capacity <W>
 *   node src/cli.ts compare (--set <id> | --items <items.json>) --capacities 3,5,7
 *   node src/cli.ts explain --analysis <id>
 *   node src/cli.ts history
 *   node src/cli.ts export --analysis <id> [--out file.json]
 *   node src/cli.ts demo
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  DEFAULT_LIMITS,
  KnapsackError,
  solveCompare,
  solveKnapsack,
  validateCapacity,
  validateItems,
  type Item,
  type SolveResult,
} from "./core.ts";
import { Store } from "./db.ts";
import { createServer } from "./server.ts";

interface Args {
  _: string[];
  [key: string]: string | boolean | string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    } else {
      (args._ as string[]).push(token);
    }
  }
  return args;
}

function readItemsFile(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new KnapsackError("VALIDATION_ERROR", `无法读取物品文件 ${file}: ${String(err)}`);
  }
}

function printResult(result: SolveResult): void {
  console.log(`算法版本: ${result.algoVersion}`);
  console.log(`容量: ${result.capacity}  物品数: ${result.itemCount}  状态表规模: ${result.stateCount}`);
  console.log(`最优价值: ${result.bestValue}`);
  console.log(`最优方案数(不同编号子集): ${result.bestCount}`);
  console.log(`展示向量(按编号升序, 字典序最小): [${result.vector.join(",")}]`);
  console.log(`选中编号: [${result.selectedIds.join(", ")}]`);
  console.log(`核验: 总重=${result.totalWeight} (<= ${result.capacity}) 总价值=${result.totalValue}`);
}

function loadItems(args: Args, store: Store): { items: Item[]; setId: number | null } {
  if (args.set !== undefined) {
    const set = store.getItemSet(Number(args.set));
    return { items: set.items, setId: set.id };
  }
  if (args.items !== undefined) {
    const raw = readItemsFile(String(args.items));
    const list = Array.isArray(raw) ? raw : (raw as Record<string, unknown>).items;
    return { items: validateItems(list), setId: null };
  }
  throw new KnapsackError("VALIDATION_ERROR", "请用 --set <id> 或 --items <file.json> 指定物品");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const command = (args._ as string[])[0];
  const dbPath = typeof args.db === "string" ? args.db : undefined;

  switch (command) {
    case "serve": {
      const port = args.port !== undefined ? Number(args.port) : 0;
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new KnapsackError("VALIDATION_ERROR", "端口必须为 0-65535 的整数（0 表示自动选择空闲端口）");
      }
      const { start, server, store } = createServer({ port, ...(dbPath ? { dbPath } : {}) });
      const actual = await start();
      console.log(`API 服务已启动: http://127.0.0.1:${actual}/api （端口 ${actual}，数据目录 ./data）`);
      console.log("可用路由: GET /api/health, GET /api/limits, POST /api/item-sets, GET /api/item-sets[/:id],");
      console.log("  POST /api/solve, POST /api/compare, GET /api/analyses[/:id[/explain|/export]]");
      const shutdown = () => { server.close(); store.close(); process.exit(0); };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      break;
    }

    case "import": {
      const file = (args._ as string[])[1];
      if (!file) throw new KnapsackError("VALIDATION_ERROR", "用法: import <items.json> [--name 名称]");
      const raw = readItemsFile(file);
      const list = Array.isArray(raw) ? raw : (raw as Record<string, unknown>).items;
      const items = validateItems(list);
      const name = typeof args.name === "string" ? args.name : "未命名物品集";
      const store = new Store(dbPath);
      const created = store.createItemSet(name, items);
      store.close();
      console.log(`已导入物品版本 id=${created.id}（${items.length} 件物品，算法版本 ${created.algoVersion}）`);
      break;
    }

    case "solve": {
      if (args.capacity === undefined) {
        throw new KnapsackError("VALIDATION_ERROR", "缺少 --capacity <W>");
      }
      const capacity = validateCapacity(Number(args.capacity));
      const store = new Store(dbPath);
      const { items, setId } = loadItems(args, store);
      const result = solveKnapsack(items, capacity);
      const analysis = store.createAnalysis(setId, { kind: "solve", setId, capacity }, result);
      store.close();
      printResult(result);
      console.log(`已保存分析报告 id=${analysis.id}`);
      break;
    }

    case "compare": {
      if (typeof args.capacities !== "string") {
        throw new KnapsackError("VALIDATION_ERROR", "缺少 --capacities 3,5,7");
      }
      const capacities = args.capacities.split(",").map((s) => Number(s.trim()));
      const store = new Store(dbPath);
      const { items, setId } = loadItems(args, store);
      const compare = solveCompare(items, capacities);
      const analysis = store.createAnalysis(
        setId, { kind: "compare", setId, capacities }, compare,
      );
      store.close();
      console.log(`批量状态: ${compare.status} (成功 ${compare.summary.ok}/${compare.summary.total})`);
      for (const r of compare.results) {
        if (r.status === "ok" && r.result) {
          console.log(
            `容量 ${r.capacity}: 最优价值=${r.result.bestValue} 总重=${r.result.totalWeight} ` +
            `方案数=${r.result.bestCount} 选中=[${r.result.selectedIds.join(",")}]`,
          );
        } else {
          console.log(`容量 ${r.capacity}: 失败 [${r.error?.code}] ${r.error?.message}`);
        }
      }
      console.log(`已保存分析报告 id=${analysis.id}`);
      break;
    }

    case "explain": {
      if (args.analysis === undefined) {
        throw new KnapsackError("VALIDATION_ERROR", "缺少 --analysis <id>");
      }
      const store = new Store(dbPath);
      const analysis = store.getAnalysis(Number(args.analysis));
      store.close();
      console.log(JSON.stringify(analysis, null, 2));
      break;
    }

    case "history": {
      const store = new Store(dbPath);
      console.log("物品版本:");
      for (const s of store.listItemSets()) {
        console.log(`  set#${s.id} ${s.name} (${s.itemCount} 件, ${s.algoVersion}, ${s.createdAt})`);
      }
      console.log("分析报告:");
      for (const a of store.listAnalyses()) {
        console.log(`  analysis#${a.id} set=${a.setId ?? "-"} (${a.algoVersion}, ${a.createdAt})`);
      }
      store.close();
      break;
    }

    case "export": {
      if (args.analysis === undefined) {
        throw new KnapsackError("VALIDATION_ERROR", "缺少 --analysis <id>");
      }
      const store = new Store(dbPath);
      const analysis = store.getAnalysis(Number(args.analysis));
      store.close();
      const json = JSON.stringify(analysis, null, 2);
      if (typeof args.out === "string") {
        writeFileSync(args.out, json, "utf8");
        console.log(`已导出到 ${args.out}`);
      } else {
        console.log(json);
      }
      break;
    }

    case "demo": {
      runDemo();
      break;
    }

    default:
      console.log("命令: serve | import | solve | compare | explain | history | export | demo");
      console.log("示例: node src/cli.ts solve --items examples/items.json --capacity 5");
  }
}

function runDemo(): void {
  console.log("=== 演示 1：经典三物品，容量 5 ===");
  const base = validateItems([
    { id: 1, weight: 2, value: 3 },
    { id: 2, weight: 3, value: 4 },
    { id: 3, weight: 4, value: 5 },
  ]);
  const r1 = solveKnapsack(base, 5);
  printResult(r1);
  console.log("回溯路径:");
  for (const step of r1.path) {
    console.log(
      `  物品${step.itemId}(w=${step.weight},v=${step.value}) 剩余容量=${step.capacityBefore} ` +
      `跳过候选=${step.skipValue} 选中候选=${step.takeValue ?? "装不下"} -> ${step.decision}（${step.reason}）`,
    );
  }

  console.log("\n=== 演示 2：加入同重量同价值但编号不同的物品 4 (w=3,v=4) ===");
  const withDup = validateItems([...base, { id: 4, weight: 3, value: 4 }]);
  const r2 = solveKnapsack(withDup, 5);
  printResult(r2);
  console.log("说明: 最优价值仍为 7，但 {1,2} 与 {1,4} 是两个不同编号子集，方案数从 1 变为 2。");

  console.log("\n=== 演示 3：零价值物品产生额外最优子集 ===");
  const zeroItems = validateItems([
    { id: 1, weight: 2, value: 3 },
    { id: 2, weight: 3, value: 4 },
    { id: 3, weight: 1, value: 0 },
  ]);
  const r3 = solveKnapsack(zeroItems, 6);
  printResult(r3);
  console.log("说明: 最优价值 7 由 {1,2} 达到，剩余容量 1 可装可不装零价值物品 3，");
  console.log("      故 {1,2} 与 {1,2,3} 是两个不同的最优编号子集，方案数=2；展示向量仍取字典序最小。");

  console.log("\n=== 演示 4：容量对照（同一物品版本，多容量） ===");
  const compare = solveCompare(base, [0, 2, 4, 5, 7, 9]);
  for (const r of compare.results) {
    if (r.result) {
      console.log(
        `容量 ${r.capacity}: 最优价值=${r.result.bestValue} 总重=${r.result.totalWeight} ` +
        `方案数=${r.result.bestCount} 选中=[${r.result.selectedIds.join(",")}]`,
      );
    }
  }

  console.log("\n=== 演示 5：持久化与“重启”后读取 ===");
  const dbFile = "data/demo.db";
  const store1 = new Store(dbFile);
  const set = store1.createItemSet("演示三物品", base);
  const analysis = store1.createAnalysis(set.id, { kind: "solve", setId: set.id, capacity: 5 }, r1);
  store1.close();
  console.log(`已写入 ${dbFile}: set#${set.id}, analysis#${analysis.id}，模拟服务重启...`);
  const store2 = new Store(dbFile);
  const loaded = store2.getAnalysis(analysis.id);
  store2.close();
  const loadedResult = loaded.results as SolveResult;
  console.log(
    `重启后读取 analysis#${loaded.id}: 算法版本=${loaded.algoVersion} ` +
    `最优价值=${loadedResult.bestValue} 方案数=${loadedResult.bestCount} ` +
    `回溯步数=${loadedResult.path.length}`,
  );
}

main().catch((err) => {
  if (err instanceof KnapsackError) {
    console.error(`错误 [${err.code}] ${err.message}`);
    process.exitCode = 1;
  } else {
    console.error(err);
    process.exitCode = 1;
  }
});
