import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { KnapsackError, SolveResult, Item } from "./knapsack.js";

export interface ItemVersion {
  id: number;
  note: string;
  items: Item[];
  createdAt: string;
}

export interface Snapshot {
  id: number;
  versionId: number;
  capacity: number;
  algoVersion: string;
  params: Record<string, unknown>;
  result: SolveResult;
  createdAt: string;
}

export class Store {
  private db: DatabaseSync;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, "knapsack.db"));
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS item_versions (" +
        "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
        "note TEXT NOT NULL, " +
        "items_json TEXT NOT NULL, " +
        "created_at TEXT NOT NULL); " +
        "CREATE TABLE IF NOT EXISTS snapshots (" +
        "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
        "version_id INTEGER NOT NULL REFERENCES item_versions(id), " +
        "capacity INTEGER NOT NULL, " +
        "algo_version TEXT NOT NULL, " +
        "params_json TEXT NOT NULL, " +
        "result_json TEXT NOT NULL, " +
        "created_at TEXT NOT NULL);",
    );
  }

  close(): void {
    this.db.close();
  }

  createVersion(items: Item[], note: string): ItemVersion {
    const createdAt = new Date().toISOString();
    const info = this.db
      .prepare("INSERT INTO item_versions (note, items_json, created_at) VALUES (?, ?, ?)")
      .run(note, JSON.stringify(items), createdAt);
    return { id: Number(info.lastInsertRowid), note, items, createdAt };
  }

  getVersion(id: number): ItemVersion {
    const row = this.db
      .prepare("SELECT id, note, items_json, created_at FROM item_versions WHERE id = ?")
      .get(id) as { id: number; note: string; items_json: string; created_at: string } | undefined;
    if (!row) {
      throw new KnapsackError("UNKNOWN_VERSION", `物品版本不存在: ${id}`);
    }
    return { id: row.id, note: row.note, items: JSON.parse(row.items_json), createdAt: row.created_at };
  }

  listVersions(): Omit<ItemVersion, "items">[] {
    const rows = this.db
      .prepare("SELECT id, note, created_at FROM item_versions ORDER BY id")
      .all() as { id: number; note: string; created_at: string }[];
    return rows.map((r) => ({ id: r.id, note: r.note, createdAt: r.created_at }));
  }

  saveSnapshot(
    versionId: number,
    capacity: number,
    algoVersion: string,
    params: Record<string, unknown>,
    result: SolveResult,
  ): number {
    const createdAt = new Date().toISOString();
    const info = this.db
      .prepare(
        "INSERT INTO snapshots (version_id, capacity, algo_version, params_json, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(versionId, capacity, algoVersion, JSON.stringify(params), JSON.stringify(result), createdAt);
    return Number(info.lastInsertRowid);
  }

  getSnapshot(id: number): Snapshot {
    const row = this.db
      .prepare(
        "SELECT id, version_id, capacity, algo_version, params_json, result_json, created_at FROM snapshots WHERE id = ?",
      )
      .get(id) as
      | { id: number; version_id: number; capacity: number; algo_version: string; params_json: string; result_json: string; created_at: string }
      | undefined;
    if (!row) {
      throw new KnapsackError("UNKNOWN_SNAPSHOT", `分析快照不存在: ${id}`);
    }
    return {
      id: row.id,
      versionId: row.version_id,
      capacity: row.capacity,
      algoVersion: row.algo_version,
      params: JSON.parse(row.params_json),
      result: JSON.parse(row.result_json),
      createdAt: row.created_at,
    };
  }

  listSnapshots(): Omit<Snapshot, "result" | "params">[] {
    const rows = this.db
      .prepare("SELECT id, version_id, capacity, algo_version, created_at FROM snapshots ORDER BY id")
      .all() as { id: number; version_id: number; capacity: number; algo_version: string; created_at: string }[];
    return rows.map((r) => ({
      id: r.id,
      versionId: r.version_id,
      capacity: r.capacity,
      algoVersion: r.algo_version,
      createdAt: r.created_at,
    }));
  }
}
