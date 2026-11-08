import type { AccountUsage, UsageWindow } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { bindingWindow, gatingWindows, windowPeriod } from "@intentic/sandbox-contract/models/plan-pools";
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
   seen; another machine or person on the same account spends the window too, so the count is a floor, said as such.

   ONE RUN-OUT PER POOL, NOT PER PROVIDER (2026-11-08). Google meters its Claude and GPT models apart from its Gemini
   models, and one conversation was refused on both that day, the pools reopening eight hours apart. With one record per
   provider each refusal replaced the other's, and the file kept only the Gemini pool's: a parent asking about Opus read
   the rate of a pool Opus never spends. Each record is filed under its provider and the pool that ran out
   (`gemini:google:models:gemini`), and a reader asks for the pool the model in question spends. */

export const RunOutSchema = z.object({
    // Epoch ms the provider first refused for a spent allowance in this window.
    at: z.number(),
    // The pool that ran out, as a person names it ("five-hour", "Weekly"), where a reading named one.
    pool: z.string().optional(),
    // That pool's own key, as the provider's reading names it (`seven_day`, `google:models:gemini`): what the record is
    // filed under beside its provider. Absent where no reading named the window, and on a record written before
    // 2026-11-08, which is matched by `pool` instead.
    kind: z.string().optional(),
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

/** Every run-out on file, keyed `${provider}:${pool}` (runOutKey); read it through the lookups below, never by key. */
export type RunOuts = Readonly<Record<string, RunOut>>;

export interface RunOutStore {
    // Each pool's last run-out, one older than a week omitted: past it, the plan's every window has turned over.
    readonly read: () => Promise<RunOuts>;
    // Keeps the first refusal of a window: a later one in the same window (the burst of children all refused within a
    // minute) would only move the instant, and lose the agents it ran out under, as they settle. Another pool of the same
    // provider is another record, whatever its window.
    readonly record: (provider: string, runOut: RunOut) => Promise<void>;
}

const FORGET_AFTER_MS = 7 * 24 * 60 * 60_000;

// Two reopenings this close are one window's: a provider's "try again at 10:05 PM" against its reading's 22:05:58.
const SAME_WINDOW_S = 10 * 60;

const sameWindow = (left: RunOut, right: RunOut): boolean =>
    left.reopensAt !== undefined && right.reopensAt !== undefined && Math.abs(left.reopensAt - right.reopensAt) <= SAME_WINDOW_S;

// What a record's key names its pool by: the provider's own key for it, else the name an older record was written with,
// else the whole allowance (a plan that publishes no pools, as Cursor's and Devin's do not).
const WHOLE_ALLOWANCE = "*";
const poolKeyOf = (runOut: RunOut): string => runOut.kind ?? runOut.pool ?? WHOLE_ALLOWANCE;

/** Where a run-out is filed: its provider and the pool that ran out. */
const runOutKey = (provider: string, runOut: RunOut): string => `${provider}:${poolKeyOf(runOut)}`;

// A provider's name has no colon, and a pool's key may (`google:models:gemini`); a key with none is a record written
// before 2026-11-08, filed under its provider alone.
const providerOfKey = (key: string): string => key.split(":", 1)[0] ?? key;

// One pool's records: by its key where both name one, else by the name a person knows it by, which is all a record
// written before 2026-11-08 carries; two that name no pool are both the whole allowance.
const samePool = (left: RunOut, right: RunOut): boolean =>
    left.kind !== undefined && right.kind !== undefined ? left.kind === right.kind : left.pool === right.pool;

// Every record under its provider and pool. A file written before 2026-11-08 keyed each provider's one record by the
// provider alone; it reads as that provider's record for the pool it names, and the next write files it so.
const rekeyed = (stored: Record<string, RunOut>): Record<string, RunOut> =>
    Object.keys(stored).every((key) => key.includes(":"))
        ? stored
        : Object.fromEntries(Object.entries(stored).map(([key, runOut]) => [key.includes(":") ? key : runOutKey(key, runOut), runOut]));

// The file with this refusal on it. The first refusal of its pool's window is kept, an older record of that window filed
// under the pool's name alone taking the key it now has; a refusal in a new window replaces whatever its pool recorded.
const withRunOut = (current: Record<string, RunOut>, provider: string, runOut: RunOut) => {
    const filed = rekeyed(current);
    const ofPool = ([at, record]: readonly [string, RunOut]): boolean => providerOfKey(at) === provider && samePool(record, runOut);
    const pool = Object.entries(filed).filter(ofPool);
    const first = pool
        .map(([, record]) => record)
        .filter((record) => sameWindow(record, runOut))
        .toSorted((left, right) => left.at - right.at)[0];
    const kept = first === undefined ? runOut : { ...first, ...opt("kind", first.kind ?? runOut.kind) };
    const key = runOutKey(provider, kept);
    if (first !== undefined && first.kind === kept.kind && pool.length === 1 && pool[0]?.[0] === key) {
        return filed;
    }
    return { ...Object.fromEntries(Object.entries(filed).filter((entry) => !ofPool(entry))), [key]: kept };
};

export const fileRunOutStore = (path: string): RunOutStore => {
    const file = jsonFile<Record<string, RunOut>>(path, {
        parse: (raw) => StoredSchema.safeParse(raw).data,
        fallback: () => ({}),
        document: runOutsDocument,
    });
    return {
        read: async () => {
            const cutoff = Date.now() - FORGET_AFTER_MS;
            return Object.fromEntries(Object.entries(rekeyed(await file.read())).filter(([, runOut]) => runOut.at > cutoff));
        },
        record: async (provider, runOut) => {
            await file.update((current) => withRunOut(current, provider, runOut));
        },
    };
};

// One provider's records, newest first.
const runOutsOf = (runOuts: RunOuts, provider: string): RunOut[] =>
    Object.entries(runOuts)
        .filter(([key]) => providerOfKey(key) === provider)
        .map(([, runOut]) => runOut)
        .toSorted((left, right) => right.at - left.at);

/** The provider's newest run-out, whichever pool ran out: what a line says where no model is in question. */
export const newestRunOut = (runOuts: RunOuts, provider: string): RunOut | undefined => runOutsOf(runOuts, provider)[0];

// Whether a record is of this window: by its key, or by its name for a record written before the key was kept.
const ranOutIn = (runOut: RunOut, window: Pick<UsageWindow, "kind" | "label">): boolean =>
    runOut.kind === undefined ? runOut.pool !== undefined && runOut.pool === poolName(window) : runOut.kind === window.kind;

/** The last run-out of one of the provider's pools, where it ran out within the week. */
export const poolRunOut = (runOuts: RunOuts, provider: string, window: Pick<UsageWindow, "kind" | "label">): RunOut | undefined =>
    runOutsOf(runOuts, provider).find((runOut) => ranOutIn(runOut, window));

/**
 * The newest run-out of a pool this model spends on any of the readings, or of the whole allowance (a record naming no
 * pool, which every model spends); the provider's newest where no model is in question. Never another pool's: the
 * Gemini pool running out says nothing of how fast Opus spends Google's Claude pool.
 */
export const modelRunOut = (
    runOuts: RunOuts,
    provider: string,
    readings: readonly (AccountUsage | undefined)[],
    model: string | undefined,
): RunOut | undefined => {
    if (model === undefined) {
        return newestRunOut(runOuts, provider);
    }
    const windows = readings.flatMap((usage) => gatingWindows(usage, { id: model }));
    return runOutsOf(runOuts, provider).find(
        (runOut) => (runOut.kind === undefined && runOut.pool === undefined) || windows.some((window) => ranOutIn(runOut, window)),
    );
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
        ...opt("kind", window?.kind),
        ...opt("openedAt", reopensAt === undefined || period === undefined ? undefined : (reopensAt - period.seconds) * 1000),
        ...opt("reopensAt", reopensAt),
        models,
    };
};
