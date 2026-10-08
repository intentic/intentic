import { join } from "node:path";
import type { ManifestProblem } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import { z } from "zod";
import { opt } from "../../opt.js";
import { recordStandingProblem } from "../../store/manifest/manifest-problems.js";
import { defineDocument } from "../../store/evolution/documents.js";
import { openDocument } from "../../store/open-document.js";

// WHEN THIS SANDBOX'S DAEMON BOOTED, FOR TELLING A RESTART STORM FROM A RESTART (2026-10-05). Every boot that owns the
// history root writes its time here before anything else on it runs, a boot that fails before the gate included. A
// restart that cuts turns asks the next boot to resume them (restart-resume.ts, which `ic` now writes before every
// restart it makes), and autoResumeOnRestart does the same unasked; in a storm (a crash loop, a keeper restarting a
// sandbox that keeps failing) each boot would start every cut turn again, which is often what brings the next restart.
// So a boot that finds RESTART_STORM.boots boots within RESTART_STORM.windowMs (itself counted) resumes nothing: the
// turns stay interrupted on the record, the log says why, and the owner's settings-problems card says so for the life
// of this run. The host's keeper reads the same facts from the work signal (workload/work-signal.ts).

const BootHistorySchema = z.object({
    // Epoch ms of each recent boot, oldest first; pruned to KEPT_MS.
    boots: z.array(z.number()),
});
export const bootHistoryDocument = defineDocument({ root: "history", path: "boot-history.json", schema: BootHistorySchema });

export const RESTART_STORM = { boots: 3, windowMs: 30 * 60_000 } as const;
// Long enough to read a storm in, short enough that the file stays a handful of numbers.
const KEPT_MS = 24 * 60 * 60_000;
const KEPT_COUNT = 50;

export interface BootFacts {
    readonly bootedAt: number;
    // The boot before this one, when there was one on the record.
    readonly previousBootAt?: number;
    // Boots within the storm window, this one included.
    readonly bootsInWindow: number;
    readonly storm: boolean;
    // When the restart this boot follows was asked for (restart-resume.ts), when one was.
    readonly restartAskedAt?: number;
}

/** The boots worth keeping once this one is added: the recent ones, oldest first, a boot from the future dropped. */
export const keptBoots = (boots: readonly number[], now: number): number[] =>
    [...boots.filter((at) => at <= now && now - at <= KEPT_MS), now].toSorted((a, b) => a - b).slice(-KEPT_COUNT);

/** What a boot at `now` reads off the boots before it. */
export const bootFactsOf = (
    earlier: readonly number[],
    now: number,
    storm: { readonly boots: number; readonly windowMs: number } = RESTART_STORM,
): BootFacts => {
    const before = earlier.filter((at) => at <= now).toSorted((a, b) => a - b);
    const bootsInWindow = before.filter((at) => now - at <= storm.windowMs).length + 1;
    const previousBootAt = before.at(-1);
    return {
        bootedAt: now,
        ...opt("previousBootAt", previousBootAt),
        bootsInWindow,
        storm: bootsInWindow >= storm.boots,
    };
};

let recorded: Promise<BootFacts | undefined> | undefined;

/**
 * Records this boot, once per process, and answers what it found; every later call answers the same. Never rejects: a
 * history root that cannot be written still boots, as if no boot came before it.
 */
export const recordBoot = (
    historyRoot: string,
    logger: Pick<Logger, "warn">,
    options: { readonly now?: number; readonly restartAskedAt?: () => Promise<number | undefined> } = {},
): Promise<BootFacts | undefined> => {
    const now = options.now ?? Date.now();
    recorded ??= (async () => {
        if (historyRoot === "") {
            return undefined;
        }
        // Read before the boot's resume pass spends the ask.
        const restartAskedAt = await options.restartAskedAt?.().catch((error: unknown) => {
            logger.warn({ err: error }, "boot: whether a restart was asked for could not be read, so this boot reads as unasked");
            return undefined;
        });
        const file = openDocument(bootHistoryDocument, join(historyRoot, bootHistoryDocument.path), { fallback: () => ({ boots: [] }) });
        let earlier: readonly number[] = [];
        try {
            await file.update((current) => {
                earlier = current.boots;
                return { boots: keptBoots(current.boots, now) };
            });
        } catch (error) {
            logger.warn({ err: error }, "boot: this boot could not be recorded, so a restart storm cannot be told from a restart");
        }
        const facts = bootFactsOf(earlier, now);
        return restartAskedAt === undefined ? facts : { ...facts, restartAskedAt };
    })();
    return recorded;
};

/** This process's boot, once recordBoot ran; undefined for a daemon that does not own its history root. */
export const bootFacts = (): Promise<BootFacts | undefined> => recorded ?? Promise.resolve(undefined);

/** Test seam: forgets this process's record. */
export const resetBootRecord = (): void => {
    recorded = undefined;
};

/** The owner's card for a storm, on the boot record's own file, for the life of this run. */
export const restartStormProblem = (facts: BootFacts, windowMs: number = RESTART_STORM.windowMs): ManifestProblem => ({
    kind: "invalidEntry",
    detail: `The sandbox restarted ${String(facts.bootsInWindow)} times within ${String(Math.round(windowMs / 60_000))} minutes, so this start resumed none of the agent turns those restarts cut`,
    fix: "Each waits as interrupted in its conversation: send a message there to carry it on. If the restarts go on, the sandbox's log says what keeps ending it.",
});

export const reportRestartStorm = (historyRoot: string, facts: BootFacts): void => {
    recordStandingProblem(join(historyRoot, bootHistoryDocument.path), restartStormProblem(facts));
};
