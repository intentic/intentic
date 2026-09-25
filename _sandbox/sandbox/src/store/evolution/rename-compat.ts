import { isJsonObject, type Granularity, type JsonObject } from "./conversions.js";
import type { DocumentSpec } from "./documents.js";

// The grace window of a rename (the expand/contract of a key): for a while after a conversion renamed a key in this
// sandbox's files, every write puts the value under both names, so a rolled-back build that only knows the old name
// still finds it, and a value the old name holds that differs from the new one is an older build's edit, which wins.
// The boot step records each window in the journal when it commits a rename (state-convergence.ts); stores read it here.

export interface RenameWindow {
    readonly from: string;
    readonly to: string;
}

// Keyed by document key; set once at boot from the journal, read by every store write.
let windows = new Map<string, readonly RenameWindow[]>();

export const setRenameWindows = (active: ReadonlyMap<string, readonly RenameWindow[]>): void => {
    windows = new Map(active);
};

export const renameWindowsOf = (key: string): readonly RenameWindow[] => windows.get(key) ?? [];

// Each object the document's conversions address: the document, its entries, or its keyed values.
const eachTarget = (value: unknown, granularity: Granularity, visit: (target: JsonObject) => JsonObject): unknown => {
    if (granularity === "object") {
        return isJsonObject(value) ? visit(value) : value;
    }
    if (granularity === "entries") {
        return Array.isArray(value) ? value.map((entry) => (isJsonObject(entry) ? visit(entry) : entry)) : value;
    }
    return isJsonObject(value) ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, isJsonObject(entry) ? visit(entry) : entry])) : value;
};

// Before conversions: inside a window, an old name holding something different from the new one was edited by a build
// that reads only the old name, so its value is the newer one.
export const reconcileRenames = (raw: unknown, spec: Pick<DocumentSpec, "granularity">, active: readonly RenameWindow[]): unknown =>
    active.length === 0
        ? raw
        : eachTarget(raw, spec.granularity, (target) => {
              let current: JsonObject | undefined;
              for (const { from, to } of active) {
                  const source = current ?? target;
                  if (Object.hasOwn(source, from) && Object.hasOwn(source, to) && JSON.stringify(source[from]) !== JSON.stringify(source[to])) {
                      current ??= { ...target };
                      current[to] = source[from];
                  }
              }
              return current ?? target;
          });

// After a write's value is settled: inside a window, the old name holds the same value as the new one, right after it.
export const withOldNames = (value: unknown, spec: Pick<DocumentSpec, "granularity">, active: readonly RenameWindow[]): unknown =>
    active.length === 0
        ? value
        : eachTarget(value, spec.granularity, (target) => {
              let current = target;
              for (const { from, to } of active) {
                  if (!Object.hasOwn(current, to) || Object.hasOwn(current, from)) {
                      continue;
                  }
                  const entries = Object.entries(current);
                  const at = entries.findIndex(([key]) => key === to);
                  entries.splice(at + 1, 0, [from, current[to]]);
                  current = Object.fromEntries(entries);
              }
              return current;
          });
