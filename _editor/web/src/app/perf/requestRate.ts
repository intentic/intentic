import { takeRequestTally } from "./perf";

// HOW MANY DAEMON CALLS THIS WINDOW MAKES, AND FOR WHAT. Said once per period from every window, labelled with the
// window's kind (lib/windows/windowRole.ts), so "the editor feels slow with two windows open" can be answered from the
// record: which window asks for what, how often, and whether a change cut it.

// Longer than client diagnostics forget a quiet kind (clientDiagnostics.ts, FORGET_AFTER_MS: ten minutes), so every
// report arrives whole, with its fields, instead of being folded into a repeat count after the third.
const REPORT_EVERY_MS = 11 * 60_000;

// Routes named in a report, most-called first; the rest are counted in the total.
const NAMED_ROUTES = 8;

export type ReportFields = Record<string, string | number | boolean>;

/** One period's report from a tally: none for a period without a single call. */
export const requestRateFields = (tally: ReadonlyMap<string, number>, periodMs: number, window: string): ReportFields | undefined => {
    const requests = [...tally.values()].reduce((sum, count) => sum + count, 0);
    if (requests === 0) {
        return undefined;
    }
    const minutes = periodMs / 60_000;
    return {
        window,
        minutes: Math.round(minutes * 10) / 10,
        requests,
        perMinute: Math.round((requests / minutes) * 10) / 10,
        routes: [...tally.entries()]
            .toSorted(([, a], [, b]) => b - a)
            .slice(0, NAMED_ROUTES)
            .map(([route, count]) => `${route} ×${count}`)
            .join(`, `),
    };
};

/** Reports this window's calls every period from now on; `context` adds what the window knows about itself then. */
export const startRequestRateReports = (window: string, context: () => ReportFields, report: (fields: ReportFields) => void): void => {
    takeRequestTally();
    let since = Date.now();
    setInterval(() => {
        const now = Date.now();
        const fields = requestRateFields(takeRequestTally(), now - since, window);
        since = now;
        if (fields !== undefined) {
            report({ ...fields, ...context() });
        }
    }, REPORT_EVERY_MS);
};
