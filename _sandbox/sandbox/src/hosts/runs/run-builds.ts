import { randomUUID } from "node:crypto";
import type { Services } from "../../composition.js";
import type { DomainEvents } from "../../seams/domain-events.js";

// A RUN'S BUILD COMPILES A TREE NOTHING LANDS INTO WHILE IT DOES. `devices run` (the Run view's Run on <device>) builds
// in the owner's own tree, which is the tree every conversation's work lands into. With twenty agents landing, a build
// read half-old, half-new source: an 11-minute run of 13 failed calls in the owner's shinobi workspace on 2026-11-02
// ("changes landing during compilation caused mixed source versions"), and a rustc incremental ICE. So while a run's
// build holds a repository, a land into that repository waits for it (turn-landing.ts, land-by-hand.ts), said on the
// waiting conversation, and goes ahead by itself when the build ends.
//
// A build that hangs or a `devices run` that is killed must never hold lands for good: a hold lapses when its command
// stops renewing it (RENEW_LAPSE_MS after its last renewal) and in any case after MAX_HOLD_MS. A land that began
// writing before the build asked is not waited for here (the hold is taken outside the repository lock); the command
// reads the tree before and after its build and says when it changed anyway (bin/devices).
//
// The lands since a run was built are counted here too, from the land announcements (`agent.landed`), so the Run
// view can say whether the program running on the computer is the newest work.

// A `devices run` renews its hold every 20 seconds while its build runs; three missed renewals end it.
export const RENEW_LAPSE_MS = 60_000;
// The longest any build holds lands, renewed or not: a build past it is treated as hung and lands go ahead.
export const MAX_HOLD_MS = 30 * 60_000;
// How many lands are remembered per repository, for "N lands since": far more than a day's.
const LAND_LOG_SIZE = 2_000;

export interface BuildHold {
    readonly id: string;
    readonly repo: string;
    readonly target: string;
    readonly device: string;
    readonly startedAt: number;
}

export interface BuildReleased {
    // Lands that waited for this build, and lands that reached the repository while it held (one already writing when
    // the hold was taken, or one whose wait ran out).
    readonly waited: number;
    readonly landedDuring: number;
}

export interface RunBuilds {
    readonly hold: (input: { repo: string; target: string; device: string }) => BuildHold;
    // False when the hold is gone (released, or lapsed): the build is no longer protected.
    readonly renew: (id: string) => boolean;
    readonly release: (id: string) => BuildReleased | undefined;
    // Resolves once no build holds any of `repos`: at once when none does. `onWait` hears the holds it waits for.
    readonly settled: (repos: readonly string[], onWait?: (holds: readonly BuildHold[]) => void) => Promise<void>;
    // A land reached the main tree of these repositories.
    readonly landed: (repos: readonly string[]) => void;
    // How many lands reached `repo` after `since` (epoch ms), as far as this daemon has seen since it came up.
    readonly landsSince: (repo: string, since: number) => number;
}

interface Live extends BuildHold {
    readonly done: Promise<void>;
    readonly end: () => void;
    waited: number;
    landedDuring: number;
    lapse: ReturnType<typeof setTimeout>;
    readonly cap: ReturnType<typeof setTimeout>;
}

export const createRunBuilds = (now: () => number = Date.now): RunBuilds => {
    const live = new Map<string, Live>();
    const lands = new Map<string, number[]>();

    const drop = (id: string): Live | undefined => {
        const held = live.get(id);
        if (held === undefined) {
            return undefined;
        }
        live.delete(id);
        clearTimeout(held.lapse);
        clearTimeout(held.cap);
        held.end();
        return held;
    };

    const lapseTimer = (id: string): ReturnType<typeof setTimeout> => {
        const timer = setTimeout(() => drop(id), RENEW_LAPSE_MS);
        timer.unref?.();
        return timer;
    };

    return {
        hold: ({ repo, target, device }) => {
            const id = randomUUID();
            let end = (): void => undefined;
            const done = new Promise<void>((resolve) => {
                end = resolve;
            });
            const cap = setTimeout(() => drop(id), MAX_HOLD_MS);
            cap.unref?.();
            const held: Live = { id, repo, target, device, startedAt: now(), done, end, waited: 0, landedDuring: 0, lapse: lapseTimer(id), cap };
            live.set(id, held);
            return { id, repo, target, device, startedAt: held.startedAt };
        },
        renew: (id) => {
            const held = live.get(id);
            if (held === undefined) {
                return false;
            }
            clearTimeout(held.lapse);
            held.lapse = lapseTimer(id);
            return true;
        },
        release: (id) => {
            const held = drop(id);
            return held === undefined ? undefined : { waited: held.waited, landedDuring: held.landedDuring };
        },
        settled: async (repos, onWait) => {
            const wanted = new Set(repos);
            const holding = [...live.values()].filter((held) => wanted.has(held.repo));
            if (holding.length === 0) {
                return;
            }
            for (const held of holding) {
                held.waited += 1;
            }
            onWait?.(holding.map(({ id, repo, target, device, startedAt }) => ({ id, repo, target, device, startedAt })));
            await Promise.all(holding.map((held) => held.done));
        },
        landed: (repos) => {
            const at = now();
            for (const repo of new Set(repos)) {
                const log = lands.get(repo) ?? [];
                log.push(at);
                lands.set(repo, log.length > LAND_LOG_SIZE ? log.slice(-LAND_LOG_SIZE) : log);
                for (const held of live.values()) {
                    if (held.repo === repo) {
                        held.landedDuring += 1;
                    }
                }
            }
        },
        landsSince: (repo, since) => (lands.get(repo) ?? []).filter((at) => at > since).length,
    };
};

// What a waiting land says on its conversation: which run's build it waits for, and that it goes on by itself.
export const waitingLine = (holds: readonly BuildHold[]): string => {
    const named = [...new Set(holds.map((held) => `${held.target} (on ${held.device})`))].join(", ");
    const repos = [...new Set(holds.map((held) => held.repo))].join(", ");
    return `Waiting for the Run build of ${named} to finish compiling ${repos} before landing: a land into a repository waits while a run builds it, so the build reads one version of the source. It lands by itself when the build ends.`;
};

// Counts every land that reached the main tree, for a run's "N lands since"; answers the unsubscribe.
export const countLandsForRuns = (services: { readonly events: Pick<DomainEvents, "subscribe">; readonly runBuilds: Pick<RunBuilds, "landed"> }): (() => void) =>
    services.events.subscribe("workspace", (event) => {
        if (event.event === "agent.landed" && event.outcome === "landed") {
            services.runBuilds.landed(event.repos.map(({ repo }) => repo));
        }
    });

// The land side's one call (conversations/land): a land into the main tree waits here while a run builds any of its
// repositories, said on the conversation's activity once. Optional on the deps, so a land with no runs wired never waits.
export const waitForRunBuilds = async (
    deps: Pick<Services, "activity" | "logger"> & { readonly runBuilds?: Pick<RunBuilds, "settled"> | undefined },
    conversationId: string,
    repos: readonly string[],
): Promise<void> => {
    await deps.runBuilds?.settled(repos, (holds) => {
        deps.logger.info({ conversationId, builds: holds.map(({ target, repo }) => `${repo}:${target}`) }, "land waits for a run's build");
        void deps.activity
            .append({ direction: "system", type: "land.waiting_for_build", content: waitingLine(holds), conversationId })
            .catch((error: Error) => deps.logger.warn({ err: error, conversationId }, "could not say a land waits for a run's build"));
    });
};
