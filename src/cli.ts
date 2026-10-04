import * as fs from "node:fs";
import * as path from "node:path";
import { Store } from "./db.js";
import { KnapsackService } from "./service.js";
import { KnapsackError } from "./knapsack.js";
import { startServer } from "./server.js";

function dataDir(): string {
  return process.env.KNAPSACK_DATA_DIR ?? path.join(process.cwd(), "data");
}

function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function printJson(x: unknown): void {
  console.log(JSON.stringify(x, null, 2));
}

const USAGE = `零一背包求解服务 CLI
用法: node dist/cli.js <命令> [参数]

命令:
  serve [--port N]                 启动 HTTP API（默认 0 = 自动选择空闲端口）
  import <items.json> [--note 说明] 导入物品集，创建物品版本
  versions                         列出物品版本
  solve --version N --capacity C   求解并保存快照
  compare --version N --capacities 5,7,10  多容量对照（逐项状态）
  explain --snapshot N             查看回溯解释
  verify --snapshot N              核验选中集合重量与价值
  history                          列出历史快照
  export --snapshot N [--out file] 导出快照 JSON
  limits                           查看算法版本与限制

物品文件格式: {"items":[{"id":1,"weight":2,"value":3}, ...], "note":"可选"}
数据目录: 环境变量 KNAPSACK_DATA_DIR，默认 ./data
`;

export async function runCli(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const { positional, flags } = parseArgs(rest);
  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log(USAGE);
    return 0;
  }
  const store = new Store(dataDir());
  const service = new KnapsackService(store);
  try {
    switch (cmd) {
      case "serve": {
        const port = flags.port !== undefined ? Number(flags.port) : 0;
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
          throw new KnapsackError("VALIDATION", "端口必须是 0-65535 的整数（0 表示自动选择空闲端口）");
        }
        const actual = await startServer(service, port);
        console.log(`API 服务已启动: http://127.0.0.1:${actual}  (数据目录: ${dataDir()})`);
        return 0; // 进程常驻
      }
      case "import": {
        const file = positional[0];
        if (!file) throw new KnapsackError("VALIDATION", "缺少物品文件路径");
        const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
        const items = Array.isArray(parsed) ? parsed : parsed.items;
        const note = flags.note ?? (Array.isArray(parsed) ? "" : String(parsed.note ?? ""));
        const v = service.importItems(items, note);
        printJson({ versionId: v.id, itemCount: v.items.length, createdAt: v.createdAt });
        return 0;
      }
      case "versions":
        printJson(service.versions());
        return 0;
      case "solve": {
        const r = service.solve(Number(flags.version), Number(flags.capacity));
        printJson(r);
        return 0;
      }
      case "compare": {
        const capacities = String(flags.capacities ?? "")
          .split(",")
          .filter((s) => s.trim() !== "")
          .map(Number);
        printJson(service.compare(Number(flags.version), capacities));
        return 0;
      }
      case "explain":
        printJson(service.explain(Number(flags.snapshot)));
        return 0;
      case "verify":
        printJson(service.verify(Number(flags.snapshot)));
        return 0;
      case "history":
        printJson(service.history());
        return 0;
      case "export": {
        const data = service.exportSnapshot(Number(flags.snapshot));
        if (flags.out) {
          fs.writeFileSync(flags.out, JSON.stringify(data, null, 2), "utf-8");
          console.log(`已导出到 ${flags.out}`);
        } else {
          printJson(data);
        }
        return 0;
      }
      case "limits":
        printJson({ algoVersion: "dp-01knapsack/1.0.0", limits: service.getLimits() });
        return 0;
      default:
        console.error(`未知命令: ${cmd}\n`);
        console.log(USAGE);
        return 2;
    }
  } catch (e) {
    if (e instanceof KnapsackError) {
      console.error(`错误 [${e.code}] ${e.message}`);
    } else {
      console.error(`错误 [INTERNAL] ${String(e)}`);
    }
    return 1;
  } finally {
    if (cmd !== "serve") store.close();
  }
}

const isMain = process.argv[1] && import.meta.url === new URL(`file:///${path.resolve(process.argv[1]).replace(/\\/g, "/")}`).href;
if (isMain) {
  runCli(process.argv.slice(2)).then((code) => {
    if (code !== 0) process.exitCode = code;
  });
}
