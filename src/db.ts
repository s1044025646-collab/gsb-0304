/**
 * SQLite 持久化（node:sqlite，无需原生编译依赖）。
 *
 * - item_sets：物品版本，导入后不可修改；再次导入生成新版本，绝不覆盖。
 * - analyses：分析快照，记录算法版本、原始参数与完整结果 JSON。
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { ALGO_VERSION, KnapsackError, type Item } from "./core.ts";

export interface ItemSetRow {
  id: number;
  name: string;
  algoVersion: string;
  createdAt: string;
  items: Item[];
}

export interface AnalysisRow {
  id: number;
  setId: number | null;
  algoVersion: string;
  createdAt: string;
  params: unknown;
  results: unknown;
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath?: string) {
    const file = dbPath ?? path.join(process.cwd(), "data", "knapsack.db");
    if (file !== ":memory:") {
      mkdirSync(path.dirname(file), { recursive: true });
    }
    this.db = new DatabaseSync(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS item_sets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        algo_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        items_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS analyses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        set_id INTEGER,
        algo_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        params_json TEXT NOT NULL,
        results_json TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  createItemSet(name: string, items: Item[]): ItemSetRow {
    const stmt = this.db.prepare(
      "INSERT INTO item_sets (name, algo_version, created_at, items_json) VALUES (?, ?, ?, ?)",
    );
    const createdAt = new Date().toISOString();
    const info = stmt.run(name, ALGO_VERSION, createdAt, JSON.stringify(items));
    return { id: Number(info.lastInsertRowid), name, algoVersion: ALGO_VERSION, createdAt, items };
  }

  getItemSet(id: number): ItemSetRow {
    const row = this.db
      .prepare("SELECT id, name, algo_version, created_at, items_json FROM item_sets WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    if (!row) {
      throw new KnapsackError("NOT_FOUND", `物品版本 ${id} 不存在`);
    }
    return {
      id: row.id as number,
      name: row.name as string,
      algoVersion: row.algo_version as string,
      createdAt: row.created_at as string,
      items: JSON.parse(row.items_json as string) as Item[],
    };
  }

  listItemSets(): (Omit<ItemSetRow, "items"> & { itemCount: number })[] {
    const rows = this.db
      .prepare("SELECT id, name, algo_version, created_at, items_json FROM item_sets ORDER BY id")
      .all() as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as number,
      name: row.name as string,
      algoVersion: row.algo_version as string,
      createdAt: row.created_at as string,
      itemCount: (JSON.parse(row.items_json as string) as Item[]).length,
    }));
  }

  createAnalysis(setId: number | null, params: unknown, results: unknown): AnalysisRow {
    const stmt = this.db.prepare(
      "INSERT INTO analyses (set_id, algo_version, created_at, params_json, results_json) VALUES (?, ?, ?, ?, ?)",
    );
    const createdAt = new Date().toISOString();
    const info = stmt.run(
      setId,
      ALGO_VERSION,
      createdAt,
      JSON.stringify(params),
      JSON.stringify(results),
    );
    return {
      id: Number(info.lastInsertRowid),
      setId,
      algoVersion: ALGO_VERSION,
      createdAt,
      params,
      results,
    };
  }

  getAnalysis(id: number): AnalysisRow {
    const row = this.db
      .prepare(
        "SELECT id, set_id, algo_version, created_at, params_json, results_json FROM analyses WHERE id = ?",
      )
      .get(id) as Record<string, unknown> | undefined;
    if (!row) {
      throw new KnapsackError("NOT_FOUND", `分析报告 ${id} 不存在`);
    }
    return {
      id: row.id as number,
      setId: row.set_id as number | null,
      algoVersion: row.algo_version as string,
      createdAt: row.created_at as string,
      params: JSON.parse(row.params_json as string),
      results: JSON.parse(row.results_json as string),
    };
  }

  listAnalyses(): Omit<AnalysisRow, "params" | "results">[] {
    const rows = this.db
      .prepare("SELECT id, set_id, algo_version, created_at FROM analyses ORDER BY id")
      .all() as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as number,
      setId: row.set_id as number | null,
      algoVersion: row.algo_version as string,
      createdAt: row.created_at as string,
    }));
  }
}
