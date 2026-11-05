import { join } from "node:path";
import type { ManifestProblem } from "@intentic/sandbox-contract/schemas/system";
import type { Logger } from "pino";
import { z } from "zod";
import { opt } from "../../../opt.js";
import { logsRoot } from "../../../seams/logs-root.js";
import { recordStandingProblem } from "../../../store/manifest/manifest-problems.js";
import { defineDocument } from "../../../store/evolution/documents.js";
import { openDocument } from "../../../store/open-document.js";
import { NETD_KILLS_FILE, NetdKillSchema } from "../../resources/memory-records.js";
import { neverStartedBoots, readTrail } from "./memory-trail.js";

// WHEN THIS SANDBOX'S DAEMON BOOTED, FOR TELLING A RESTART STORM FROM A RESTART (2026-10-05). Every boot that owns the
// history root writes its time here before anything else on it runs, a boot that fails before the gate included. A
// restart that cuts turns asks the next boot to resume them (restart-resume.ts, which `ic` now writes before every
// restart it makes), and autoResumeOnRestart does the same unasked; in a storm (a crash loop, a keeper restarting a
// sandbox that keeps failing) each boot would start every cut turn again, which is often what brings the next restart.
// So a boot that finds RESTART_STORM.boots boots within RESTART_STORM.windowMs (itself counted) resumes nothing: the
// turns stay interrupted on the record, the log says why, and the owner's settings-problems card says so for the life
// of this run. The host's keeper reads the same facts from the work signal (workload/work-signal.ts).
//
// A boot netd killed for never saying hello is not counted (2026-11-05). When the machine itself is starved (a runaway
// thrashing the VM's swap), netd kills a daemon whose loop stopped, then every daemon it starts in its place that cannot
// load in HELLO_DEADLINE, one every three minutes until memory comes back. On 2026-11-05 those ~33 never got as far as
// recording themselves, so the count was 1; but a daemon that loads a little faster records its boot first thing
// (daemon-env.ts) and is killed before its hello all the same, and three of those in half an hour would have held the
// one boot that finally came up from resuming anything. They are not the loop the storm guards against: netd's hello is
// said before the boot chain and long before any resume (main.ts), so a boot that never said it resumed nothing and
// cannot have been brought down by what it resumed; what killed it was the machine, which the post-mortem names. A boot
// that crashed or failed of its own before the gate still counts, as before: that loop is the sandbox's, not the
// machine's. Which boots netd killed so is read off netd-kills.jsonl (memory-trail.ts neverStartedBoots).

const BootHistorySchema = z.object({
    // Epoch ms of each recent boot, oldest first; pruned to KEPT_MS.
    boots: z.array(z.number()),
});
export const bootHistoryDocument = defineDocument({
    root: "history",
    path: "boot-history.json",
    // When this machine's daemon booted, for telling a restart storm from a restart: about
    // this machine's restarts, so a moved sandbox starts without it.
    portability: "derived",
    schema: BootHistorySchema,
});

export const RESTART_STORM = { boots: 3, windowMs: 30 * 60_000 } as const;
// Long enough to read a storm in, short enough that the file stays a handful of numbers.
const KEPT_MS = 24 * 60 * 60_000;
const KEPT_COUNT = 50;

export interface BootFacts {
    readonly bootedAt: number;
    // The boot before this one, when there was one on the record.
    readonly previousBootAt?: number;
    // Boots within the storm window, this one included, less those netd killed before they said hello.
    readonly bootsInWindow: number;
    // Boots within the window netd killed for never saying hello, left out of the count; absent when none.
    readonly neverStartedInWindow?: number;
    readonly storm: boolean;
    // When the restart this boot follows was asked for (restart-resume.ts), when one was.
    readonly restartAskedAt?: number;
}

/** The boots worth keeping once this one is added: the recent ones, oldest first, a boot from the future dropped. */
export const keptBoots = (boots: readonly number[], now: number): number[] =>
    [...boots.filter((at) => at <= now && now - at <= KEPT_MS), now].toSorted((a, b) => a - b).slice(-KEPT_COUNT);

/** What a boot at `now` reads off the boots before it; `neverStarted` are those netd killed before their hello. */
export const bootFactsOf = (
    earlier: readonly number[],
    now: number,
    storm: { readonly boots: number; readonly windowMs: number } = RESTART_STORM,
    neverStarted: ReadonlySet<number> = new Set(),
): BootFacts => {
    const before = earlier.filter((at) => at <= now).toSorted((a, b) => a - b);
    const inWindow = before.filter((at) => now - at <= storm.windowMs);
    const unstarted = inWindow.filter((at) => neverStarted.has(at)).length;
    const bootsInWindow = inWindow.length - unstarted + 1;
    const previousBootAt = before.at(-1);
    return {
        bootedAt: now,
        ...opt("previousBootAt", previousBootAt),
        bootsInWindow,
        ...opt("neverStartedInWindow", unstarted > 0 ? unstarted : undefined),
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
        const netd = readTrail(logsRoot(historyRoot), NETD_KILLS_FILE, NetdKillSchema);
        if (netd.unreadable !== undefined) {
            logger.warn({ reason: netd.unreadable }, "boot: netd's record of the daemons it killed could not be read, so every boot counts towards a restart storm");
        }
        const facts = bootFactsOf(earlier, now, RESTART_STORM, neverStartedBoots(earlier, netd.rows));
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
