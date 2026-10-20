import type { AccountUsage } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { z } from "zod";
import { defineDocument } from "../../../store/evolution/documents.js";
import { openLedger } from "../../../store/open-document.js";
import { opt } from "../../../opt.js";

/* EVERY READING OF AN ACCOUNT'S WINDOWS, AS A HISTORY, at <historyRoot>/usage-readings.jsonl. The snapshot store
   (account-usage.json) keeps each account's latest reading and nothing before it, and the log keeps only an account's
   change of state ("ready → spent"), so how fast a window moved under a fan-out could be read off nothing afterwards
   (2026-10-20). One line per reading that moved something: a window's figure or its reset. A reading that only repeats
   the last one says nothing a rate could use, and a sandbox with two dozen benched accounts would write one every
   sweep. Pruned to its newest lines past a few megabytes: it is a week of history for reading back, not a ledger. */

const WindowLineSchema = z.object({
    kind: z.string(),
    utilization: z.number(),
    resetsAt: z.number().optional(),
});

export const ReadingLineSchema = z.object({
    // Epoch ms the reading was taken.
    at: z.number(),
    provider: z.string(),
    // The reading's key: a Claude account id, or `${provider}:${authFile}` for a routed one.
    account: z.string(),
    windows: z.array(WindowLineSchema),
});
export type ReadingLine = z.infer<typeof ReadingLineSchema>;

export const readingsLogDocument = defineDocument({
    root: "history",
    path: "usage-readings.jsonl",
    // The history behind account-usage.json's latest readings, which carries: travels with it.
    portability: "carry",
    schema: ReadingLineSchema,
    granularity: "entries",
    boot: false,
});

const MAX_BYTES = 4_000_000;
const KEEP_LINES = 20_000;

export interface ReadingsLog {
    // Appends the reading where it moved something since the account's last line; answers whether it wrote one.
    readonly append: (provider: string, account: string, usage: AccountUsage) => Promise<boolean>;
    // Every line kept, oldest first.
    readonly read: () => Promise<ReadingLine[]>;
}

const lineOf = (provider: string, account: string, usage: AccountUsage): ReadingLine => ({
    at: usage.measuredAt,
    provider,
    account,
    windows: usage.windows.map((window) => ({ kind: window.kind, utilization: window.utilization, ...opt("resetsAt", window.resetsAt) })),
});

// What a line says, without when it was read: two readings saying the same are one line.
const sayingOf = (line: ReadingLine): string => JSON.stringify(line.windows);

export const fileReadingsLog = (path: string): ReadingsLog => {
    const ledger = openLedger(readingsLogDocument, path, { cap: { overBytes: MAX_BYTES, keepLines: KEEP_LINES } });
    // What each account's last line said, as this process wrote it; a restart writes each account's first reading again.
    const last = new Map<string, string>();
    return {
        append: async (provider, account, usage) => {
            if (usage.windows.length === 0) {
                return false;
            }
            const line = lineOf(provider, account, usage);
            const saying = sayingOf(line);
            if (last.get(account) === saying) {
                return false;
            }
            last.set(account, saying);
            await ledger.append(line);
            return true;
        },
        read: async () => ledger.read(),
    };
};
