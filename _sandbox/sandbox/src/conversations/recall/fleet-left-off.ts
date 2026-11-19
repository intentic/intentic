import type { LoopRecord } from "@intentic/sandbox-contract/schemas/loops";
import type { Logger } from "pino";
import type { Services } from "../../composition.js";
import { opt } from "../../opt.js";
import { type Chore, DAY_MS } from "../../system/chore-clock.js";
import { type PersistedAgent, worktreeOf } from "../registry/agents-store.js";

// WHERE WORK WAS LEFT OFF, as `agents ls` and `agents show` say it: a loop still carrying a conversation on, and work that
// stopped without ever landing. In the 2026-11 audit of a game-dev sandbox, stopped work sat on its branch until the owner
// happened to remember it, and an agent picked items two other conversations had already done.

/** How long work may sit stopped and unlanded before the roster calls it forgotten, when the ask names no figure. */
export const UNLANDED_HOURS = 24;

const HOUR_MS = 3_600_000;

/** The instant before which a conversation's last activity makes its unlanded work forgotten, `hours` from `now`. */
export const unlandedBefore = (hours: number, now: number): number => now - hours * HOUR_MS;

/**
 * Whether a conversation stopped with work that never landed, idle since before `before`: nothing running, its work
 * outstanding against the workspace (ready to land, or refused for a conflict), and its own rather than a subagent's,
 * whose work lands into the agent that started it.
 */
export const stoppedUnlanded = (
    deps: { readonly agents: Pick<Services["agents"], "standingOf">; readonly conversations: Pick<Services["conversations"], "running"> },
    entry: PersistedAgent,
    before: number,
): boolean => {
    if (entry.updatedAt > before || worktreeOf(entry)?.parent !== undefined || deps.conversations.running(entry.id)) {
        return false;
    }
    const standing = deps.agents.standingOf(entry.id);
    return standing === "ready" || standing === "conflict";
};

/** A loop as a roster row says it: how far it has got, what the last round counted, and how it ends or ended. */
export interface FleetLoop {
    readonly state: LoopRecord["state"];
    readonly round: number;
    readonly max: number;
    readonly remaining?: number;
    readonly until?: string;
    readonly last?: string;
}

// The last round's own words, a line: the full history is `GET /loops`.
const LAST_CHARS = 200;

export const fleetLoopOf = (record: LoopRecord): FleetLoop => {
    const last = record.iterations.at(-1);
    const until = record.checks.find((check) => check.kind === "command");
    return {
        state: record.state,
        round: record.iterations.length,
        max: record.maxIterations,
        ...opt("remaining", last?.remaining),
        ...opt("until", until?.kind === "command" ? until.command : undefined),
        ...opt("last", (record.detail ?? last?.detail)?.slice(0, LAST_CHARS)),
    };
};

/** Roster rows with the loop each conversation is running, where one is; `records` is the loops manifest. */
export const withLoops = <Row extends { readonly id: string }>(rows: readonly Row[], records: readonly LoopRecord[]): readonly (Row & { readonly loop?: FleetLoop })[] => {
    const running = new Map(records.filter((record) => record.state === "running").map((record) => [record.conversationId, fleetLoopOf(record)]));
    return rows.map((row) => {
        const loop = running.get(row.id);
        return loop === undefined ? row : { ...row, loop };
    });
};

/** What the daily notice reads and how it tells: the registry, which turns run, and the push it sends. */
export interface UnlandedWorkDeps {
    readonly agents: Pick<Services["agents"], "ids" | "entry" | "standingOf">;
    readonly conversations: Pick<Services["conversations"], "running">;
    readonly tell: (count: number, hours: number) => Promise<void>;
    readonly logger: Pick<Logger, "info">;
    readonly now?: () => number;
}

/**
 * The housekeeping clock's daily look (system/chore-clock.ts, which keeps when it last ran across restarts): how many
 * live conversations hold work stopped and never landed for a day or more, told to the sandbox's operators when any do.
 */
export const unlandedWorkChore = (deps: UnlandedWorkDeps): Chore => ({
    name: "unlanded-work",
    everyMs: DAY_MS,
    run: async () => {
        const before = unlandedBefore(UNLANDED_HOURS, (deps.now ?? Date.now)());
        const forgotten = deps.agents.ids().filter((id) => {
            const entry = deps.agents.entry(id);
            return entry !== undefined && entry.archivedAt === undefined && stoppedUnlanded(deps, entry, before);
        });
        if (forgotten.length > 0) {
            deps.logger.info({ count: forgotten.length, conversations: forgotten.slice(0, 20) }, "unlanded work: told the operators");
            await deps.tell(forgotten.length, UNLANDED_HOURS);
        }
    },
});
