import type { DocumentRoot } from "./documents.js";

// Conversions that are not a rewrite of one document's fields: a file split in two, a directory of ledgers folded into
// a database. Each is a guarded, deterministic step the boot step runs before the per-document conversions, planned
// against read-only views so the pre-flight can run the very same plan without touching anything.

export interface StepContext {
    // Each volume's root, absolute.
    readonly roots: Readonly<Record<DocumentRoot, string>>;
    // A file's text as it stands after the steps planned so far, or undefined when absent.
    readonly read: (path: string) => Promise<string | undefined>;
    // File names directly inside a directory, as it stands after the steps planned so far; empty when absent.
    readonly list: (dir: string) => Promise<string[]>;
    // What stands at a path after the steps planned so far.
    readonly kind: (path: string) => Promise<"file" | "directory" | undefined>;
}

export interface StepPlan {
    // One line each, for the plan and the ledger.
    readonly changes: readonly string[];
    // Absolute path to its new text, or undefined to delete it.
    readonly writes: ReadonlyMap<string, string | undefined>;
    // Trees or files copied byte for byte, source to destination (absent before, removed again on a rollback).
    readonly copies?: ReadonlyMap<string, string>;
    // Trees or files renamed, source to destination: instant on one volume, and put back by a rollback.
    readonly renames?: ReadonlyMap<string, string>;
    // Files the effect below changes, copied aside first like every write (a database and its sidecars).
    readonly touches?: readonly string[];
    // Work beyond file writes, run once the writes are in place.
    readonly effect?: () => Promise<void>;
}

export interface StructuralStep {
    // Stable forever: the ledger records it and the conversion digest (documents.ts) names it.
    readonly id: string;
    readonly describe: string;
    // When it runs: a layout step brings whole trees to their current addresses before documents move one by one; a
    // content step (the default) reads and rewrites documents already at their current addresses.
    readonly phase?: "layout" | "content";
    // Undefined when there is nothing to do, which must be true of its own output (a step settles like a conversion).
    readonly plan: (context: StepContext) => Promise<StepPlan | undefined>;
}

// Typing only: a step registers nothing by being defined. The boot step and the pre-flight read every step from
// state-registry.ts, which the shape generator writes from every `export const name = defineStep(…)` in the source.
export const defineStep = (step: StructuralStep): StructuralStep => step;
