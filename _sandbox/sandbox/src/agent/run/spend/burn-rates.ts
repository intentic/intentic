import type { AccountUsage } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { z } from "zod";
import { defineDocument } from "../../../store/evolution/documents.js";
import { openDocument } from "../../../store/open-document.js";
import { type Anchor, averaged, MIN_PACE_MS, stepAnchor } from "./burn-learning.js";
import type { ReadingsLog } from "./readings-log.js";
import { accountTokensBetween, METER_RETAIN_MS } from "./token-meter.js";
import { opt } from "../../../opt.js";

/* WHAT THIS SANDBOX HAS LEARNED OF HOW FAST ITS AGENTS SPEND, at <historyRoot>/burn-rates.json, kept across restarts
   since each figure takes a window's worth of readings to settle:
   - per account and window: what one point of the window costs in the meter's unit (burn-learning.ts);
   - per provider and model: what a turn on it spends an hour, and how long a child's turn on it runs.
   The fan-out planner (fan-out-budget.ts) projects from these, and from its priors where nothing was learned yet.
   Every reading also goes to the readings history (readings-log.ts), which is what these were learned from. */

const AverageSchema = z.object({ value: z.number(), samples: z.number().int().nonnegative(), at: z.number() });

const ModelPaceSchema = z.object({
    // Meter units an hour, over turns that ran at least MIN_PACE_MS.
    tokensPerHour: AverageSchema.optional(),
    // Hours a child's turn on it ran, start to end.
    childHours: AverageSchema.optional(),
});

export const BurnRatesSchema = z.object({
    // `${provider}\u0000${account}` → window kind → what one point costs.
    points: z.record(z.string(), z.record(z.string(), AverageSchema)),
    // `${provider}/${model}` → its pace.
    models: z.record(z.string(), ModelPaceSchema),
});
export type BurnRatesValue = z.infer<typeof BurnRatesSchema>;

export const burnRatesDocument = defineDocument({
    root: "history",
    path: "burn-rates.json",
    // Each model's learned pace, read off the same accounts account-usage.json carries: travels with them.
    portability: "carry",
    schema: BurnRatesSchema,
});

/** A turn's end, as its model's pace is learned from it. */
export interface EndedTurn {
    readonly provider: string;
    readonly model: string | undefined;
    readonly startedAt: number;
    readonly endedAt: number;
    readonly weighted: number;
    // A spawned child's turn: only these say how long a child runs, since a person's turns are answers, not tasks.
    readonly child: boolean;
}

export interface ModelPace {
    readonly tokensPerHour?: number;
    readonly childHours?: number;
}

export interface BurnRates {
    // Loaded before anything is asked of it, once; the planner awaits it so its answers never come from an empty start.
    readonly ready: () => Promise<void>;
    // What one point of this account's window costs, where learned.
    readonly tokensPerPoint: (provider: string, account: string, windowKind: string) => number | undefined;
    readonly modelPace: (provider: string, model: string) => ModelPace | undefined;
    // A reading landed: kept in the history, and each window's interval stepped on.
    readonly reading: (provider: string, account: string, usage: AccountUsage) => Promise<void>;
    readonly turnEnded: (turn: EndedTurn) => Promise<void>;
}

const pointsKey = (provider: string, account: string): string => `${provider}\u0000${account}`;
const modelKey = (provider: string, model: string): string => `${provider}/${model}`;

const empty = (): BurnRatesValue => ({ points: {}, models: {} });

export interface BurnRatesDeps {
    readonly path: string;
    readonly log: ReadingsLog;
    // What the meter saw on an account in [from, to); the live meter by default.
    readonly metered?: (provider: string, account: string, from: number, to: number) => number;
    readonly now?: () => number;
}

export const createBurnRates = ({ path, log, metered = accountTokensBetween, now = Date.now }: BurnRatesDeps): BurnRates => {
    const file = openDocument(burnRatesDocument, path, { fallback: empty });
    let value: BurnRatesValue = empty();
    // allow(silent-catch): an unreadable file starts the learning afresh; nothing it held is load-bearing.
    const loading = file.read().then(
        (read) => {
            value = read;
        },
        () => undefined,
    );
    // Each window's open interval, in memory: a restart opens it again from the next reading.
    const anchors = new Map<string, Anchor>();
    const save = async (): Promise<void> => {
        // allow(silent-catch): a figure that fails to persist is still held in memory and written with the next one.
        await file.update(() => value).catch(() => undefined);
    };
    const meteredFor =
        (provider: string, account: string) =>
        (from: number, to: number): number | undefined =>
            now() - from > METER_RETAIN_MS ? undefined : metered(provider, account, from, to);
    return {
        ready: () => loading,
        tokensPerPoint: (provider, account, windowKind) => value.points[pointsKey(provider, account)]?.[windowKind]?.value,
        modelPace: (provider, model) => {
            const pace = value.models[modelKey(provider, model)];
            return pace === undefined ? undefined : { ...opt("tokensPerHour", pace.tokensPerHour?.value), ...opt("childHours", pace.childHours?.value) };
        },
        reading: async (provider, account, usage) => {
            await loading;
            // allow(silent-catch): the history is for reading back; a failed append costs it one line, never the rates.
            await log.append(provider, account, usage).catch(() => false);
            let learned = false;
            const key = pointsKey(provider, account);
            for (const window of usage.windows) {
                const anchorKey = `${key}\u0000${window.kind}`;
                const step = stepAnchor(anchors.get(anchorKey), { utilization: window.utilization, resetsAt: window.resetsAt, at: usage.measuredAt }, meteredFor(provider, account));
                anchors.set(anchorKey, step.anchor);
                if (step.tokensPerPoint !== undefined) {
                    const windows = { ...value.points[key], [window.kind]: averaged(value.points[key]?.[window.kind], step.tokensPerPoint, usage.measuredAt) };
                    value = { ...value, points: { ...value.points, [key]: windows } };
                    learned = true;
                }
            }
            if (learned) {
                await save();
            }
        },
        turnEnded: async (turn) => {
            await loading;
            const lasted = turn.endedAt - turn.startedAt;
            if (turn.model === undefined || lasted <= 0) {
                return;
            }
            const key = modelKey(turn.provider, turn.model);
            const before = value.models[key] ?? {};
            const paced = lasted >= MIN_PACE_MS && turn.weighted > 0;
            if (!paced && !turn.child) {
                return;
            }
            const next = {
                ...before,
                ...opt("tokensPerHour", paced ? averaged(before.tokensPerHour, (turn.weighted / lasted) * 3_600_000, turn.endedAt) : before.tokensPerHour),
                ...opt("childHours", turn.child ? averaged(before.childHours, lasted / 3_600_000, turn.endedAt) : before.childHours),
            };
            value = { ...value, models: { ...value.models, [key]: next } };
            await save();
        },
    };
};
