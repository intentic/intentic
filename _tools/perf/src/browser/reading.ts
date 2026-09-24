import type { Reading } from "../baseline.js";
import { callsByOwner } from "./coverage.js";
import type { Window } from "./session.js";

// A component is named in the baseline once it re-renders this often in one window: below it the per-component rows
// would outnumber the totals they explain, and a component that starts re-rendering still moves `vue.renders`.
export const NAMED_RENDERS = 2;

const sum = (counts: Readonly<Record<string, number>>): number => Object.values(counts).reduce((total, count) => total + count, 0);

/** Folds one window into the metrics the baseline stores; without `frames`, the layout and style counts are left out. */
export const readingOf = (window: Window, frames: boolean): Reading => {
    const calls = callsByOwner(window.scripts);
    const named = Object.entries(window.probe.renders).filter(([, count]) => count >= NAMED_RENDERS);
    return {
        "vue.renders": sum(window.probe.renders),
        "vue.mounts": sum(window.probe.mounts),
        ...Object.fromEntries(named.map(([name, count]) => [`vue.render:${name}`, count])),
        "v8.calls": calls.app + calls.fixture + calls.dependency,
        "v8.calls.app": calls.app,
        ...(frames ? { "blink.layouts": window.layouts, "blink.styleRecalcs": window.styles } : {}),
        "dom.records": window.probe.mutations.records,
        "dom.added": window.probe.mutations.added,
        "dom.removed": window.probe.mutations.removed,
    };
};
