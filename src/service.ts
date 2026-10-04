import { Store } from "./db.js";
import {
  ALGO_VERSION,
  DEFAULT_LIMITS,
  Item,
  KnapsackError,
  Limits,
  SolveResult,
  solveKnapsack,
  validateCapacity,
  validateItems,
} from "./knapsack.js";

export interface SolveResponse {
  snapshotId: number;
  versionId: number;
  algoVersion: string;
  result: SolveResult;
}

export interface CompareEntry {
  capacity: number;
  status: "ok" | "error";
  snapshotId?: number;
  bestValue?: number;
  totalWeight?: number;
  count?: string;
  selectedIds?: number[];
  error?: { code: string; message: string };
}

export class KnapsackService {
  constructor(
    private store: Store,
    private limits: Limits = DEFAULT_LIMITS,
  ) {}

  getLimits(): Limits {
    return this.limits;
  }

  importItems(items: Item[], note: string) {
    const sorted = validateItems(items, this.limits);
    return this.store.createVersion(sorted, note);
  }

  solve(versionId: number, capacity: number): SolveResponse {
    const version = this.store.getVersion(versionId);
    const result = solveKnapsack(version.items, capacity, this.limits);
    const params = { versionId, capacity, limits: this.limits };
    const snapshotId = this.store.saveSnapshot(versionId, capacity, ALGO_VERSION, params, result);
    return { snapshotId, versionId, algoVersion: ALGO_VERSION, result };
  }

  // 逐项结果模式：每个容量独立求解并记录各自状态，绝不把部分成功汇报为全部完成
  compare(versionId: number, capacities: number[]): { versionId: number; entries: CompareEntry[] } {
    if (!Array.isArray(capacities) || capacities.length === 0) {
      throw new KnapsackError("VALIDATION", "容量列表不能为空");
    }
    if (capacities.length > 100) {
      throw new KnapsackError("LIMIT_EXCEEDED", "单次对照容量数量不能超过 100");
    }
    this.store.getVersion(versionId); // 先确认版本存在
    const entries: CompareEntry[] = capacities.map((capacity) => {
      try {
        const r = this.solve(versionId, capacity);
        return {
          capacity,
          status: "ok",
          snapshotId: r.snapshotId,
          bestValue: r.result.bestValue,
          totalWeight: r.result.totalWeight,
          count: r.result.count,
          selectedIds: r.result.selectedIds,
        };
      } catch (e) {
        const err =
          e instanceof KnapsackError
            ? { code: e.code, message: e.message }
            : { code: "INTERNAL", message: String(e) };
        return { capacity, status: "error", error: err };
      }
    });
    return { versionId, entries };
  }

  explain(snapshotId: number) {
    const snap = this.store.getSnapshot(snapshotId);
    const version = this.store.getVersion(snap.versionId);
    return {
      snapshotId: snap.id,
      algoVersion: snap.algoVersion,
      params: snap.params,
      createdAt: snap.createdAt,
      items: version.items,
      result: {
        bestValue: snap.result.bestValue,
        totalWeight: snap.result.totalWeight,
        count: snap.result.count,
        selection: snap.result.selection,
        selectedIds: snap.result.selectedIds,
      },
      trace: snap.result.trace,
    };
  }

  verify(snapshotId: number) {
    const snap = this.store.getSnapshot(snapshotId);
    const version = this.store.getVersion(snap.versionId);
    const chosen = new Set(snap.result.selectedIds);
    let weight = 0;
    let value = 0;
    for (const it of version.items) {
      if (chosen.has(it.id)) {
        weight += it.weight;
        value += it.value;
      }
    }
    return {
      snapshotId: snap.id,
      selectedIds: snap.result.selectedIds,
      recomputedWeight: weight,
      recomputedValue: value,
      weightMatches: weight === snap.result.totalWeight,
      valueMatches: value === snap.result.bestValue,
      fitsCapacity: weight <= snap.capacity,
    };
  }

  exportSnapshot(snapshotId: number) {
    const snap = this.store.getSnapshot(snapshotId);
    const version = this.store.getVersion(snap.versionId);
    return {
      exportedAt: new Date().toISOString(),
      algoVersion: snap.algoVersion,
      snapshot: { ...snap, items: version.items },
    };
  }

  history() {
    return this.store.listSnapshots();
  }

  versions() {
    return this.store.listVersions();
  }

  validateCapacityOnly(capacity: number): void {
    validateCapacity(capacity, this.limits);
  }
}
