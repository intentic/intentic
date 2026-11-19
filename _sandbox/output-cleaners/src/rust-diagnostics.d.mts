// Types for rust-diagnostics.mjs: cargo/rustc output with its errors first and each repeated warning one line.
import type { Stage } from "./cleaners.mjs";

export const foldRustDiagnostics: (lines: readonly string[]) => readonly string[];

// The fold as a filter stage: its lines, and its saving under `rustc` when it changed anything and the spec allows it.
export const rustcStage: (lines: readonly string[], enabled: ReadonlySet<string>) => { lines: readonly string[]; stages: Stage[] };
