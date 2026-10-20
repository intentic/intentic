import type { AccountUsage, UsageWindow } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { bindingWindow, windowPeriod } from "@intentic/sandbox-contract/models/plan-pools";
import { z } from "zod";
import { defineDocument } from "../store/evolution/documents.js";
import { jsonFile } from "../store/json-file.js";
import { opt } from "../opt.js";

/* WHEN EACH PROVIDER'S ALLOWANCE LAST RAN OUT, AND UNDER HOW MANY OF THIS SANDBOX'S AGENTS, at
   <historyRoot>/run-outs.json, outside the agent's reach. A figure left is a level, and a parent fanning out needs a
   rate: Codex read "84% left" at 17:00 and was true, and the four Sol subagents started on it spent its whole five-hour
   window in about fifty minutes of work, as five had spent the window before it in twenty-one (2026-10-13). Nothing on
   the listing could have said so. The first refusal of each window is kept: when the window had opened, how long it
   lasted, and which models the agents running on the provider at that moment were on. Only this sandbox's agents are
   seen; another machine or person on the same account spends the window too, so the count is a floor, said as such. */

export const RunOutSchema = z.object({
    // Epoch ms the provider first refused for a spent allowance in this window.
    at: z.number(),
    // The pool that ran out, as a person names it ("five-hour", "Weekly"), where a reading named one.
    pool: z.string().optional(),
    // Epoch ms the window that ran out had opened: its reopening less its length, where both are known.
    openedAt: z.number().optional(),
    // Epoch seconds it reopens, as the refusal or the reading named it; how a later refusal knows it is the same window.
    reopensAt: z.number().optional(),
    // This sandbox's agents running on the provider at that moment, the refused one included, by model.
    models: z.record(z.string(), z.number()),
});
export type RunOut = z.infer<typeof RunOutSchema>;

const StoredSchema = z.record(z.string(), RunOutSchema);

export const runOutsDocument = defineDocument({
    root: "history",
    path: "run-outs.json",
    // When each provider's allowance last ran out and under how many agents, which the spawn listing quotes beside the
    // figure left. Carried like the refusals (provider-refusals.ts): it describes the subscription's windows, not the
    // machine that spent them.
    portability: "carry",
    schema: RunOutSchema,
    granularity: "record",
});

export interface RunOutStore {
    // Each provider's last run-out, one older than a week omitted: past it, the plan's every window has turned over.
    readonly read: () => Promise<Record<string, RunOut>>;
    // Keeps the first refusal of a window: a later one in the same window (the burst of children all refused within a
    // minute) would only move the instant, and lose the agents it ran out under, as they settle.
    readonly record: (provider: string, runOut: RunOut) => Promise<void>;
}

const FORGET_AFTER_MS = 7 * 24 * 60 * 60_000;

// Two reopenings this close are one window's: a provider's "try again at 10:05 PM" against its reading's 22:05:58.
const SAME_WINDOW_S = 10 * 60;

const sameWindow = (left: RunOut, right: RunOut): boolean =>
    left.reopensAt !== undefined && right.reopensAt !== undefined && Math.abs(left.reopensAt - right.reopensAt) <= SAME_WINDOW_S;

export const fileRunOutStore = (path: string): RunOutStore => {
    const file = jsonFile<Record<string, RunOut>>(path, {
        parse: (raw) => StoredSchema.safeParse(raw).data,
        fallback: () => ({}),
        document: runOutsDocument,
    });
    return {
        read: async () => {
            const cutoff = Date.now() - FORGET_AFTER_MS;
            return Object.fromEntries(Object.entries(await file.read()).filter(([, runOut]) => runOut.at > cutoff));
        },
        record: async (provider, runOut) => {
            await file.update((current) => {
                const kept = current[provider];
                return kept !== undefined && sameWindow(kept, runOut) ? current : { ...current, [provider]: runOut };
            });
        },
    };
};

// How a person names a pool: its label where the plan gave one, else its length ("five-hour", "weekly").
const PERIOD_NAMES = new Map([
    ["5h", "five-hour"],
    ["wk", "weekly"],
    ["mo", "monthly"],
    ["24h", "daily"],
]);

export const poolName = (window: Pick<UsageWindow, "kind" | "label">): string | undefined => {
    if (window.label !== undefined) {
        return window.label;
    }
    const period = windowPeriod(window);
    return period === undefined ? undefined : (PERIOD_NAMES.get(period.short) ?? `${period.short} window`);
};

// The window that ran out: the one reopening when the refusal said, else the fullest the model spends, on any account.
const windowThatRanOut = (readings: readonly AccountUsage[], model: string | undefined, reopensAt: number | undefined): UsageWindow | undefined => {
    const windows = readings.flatMap((usage) => {
        const binding = bindingWindow(usage, model === undefined ? undefined : { id: model });
        return binding === undefined ? [] : [binding];
    });
    const named = reopensAt === undefined ? undefined : windows.find((window) => window.resetsAt !== undefined && Math.abs(window.resetsAt - reopensAt) <= SAME_WINDOW_S);
    return named ?? windows.reduce<UsageWindow | undefined>((fullest, window) => (fullest === undefined || window.utilization > fullest.utilization ? window : fullest), undefined);
};

/** A run-out as it is recorded: the refusal's moment and reopening, the window the readings show ran out, and the agents running then. */
export const runOutOf = (refusal: {
    readonly at: number;
    readonly model?: string | undefined;
    readonly resetsAt?: number | undefined;
    readonly readings: readonly AccountUsage[];
    readonly running: readonly { readonly model?: string | undefined }[];
}): RunOut => {
    const window = windowThatRanOut(refusal.readings, refusal.model, refusal.resetsAt);
    const reopensAt = refusal.resetsAt ?? window?.resetsAt;
    const period = window === undefined ? undefined : windowPeriod(window);
    const pool = window === undefined ? undefined : poolName(window);
    const models: Record<string, number> = {};
    for (const agent of refusal.running) {
        const model = agent.model ?? refusal.model ?? "default";
        models[model] = (models[model] ?? 0) + 1;
    }
    return {
        at: refusal.at,
        ...opt("pool", pool),
        ...opt("openedAt", reopensAt === undefined || period === undefined ? undefined : (reopensAt - period.seconds) * 1000),
        ...opt("reopensAt", reopensAt),
        models,
    };
};
