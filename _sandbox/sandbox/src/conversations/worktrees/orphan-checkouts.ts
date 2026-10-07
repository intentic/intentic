import { lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage, undefinedIfMissing } from "@intentic/base/errors";
import { isConversationId } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import type { UnitOwners } from "../../store/conversation-units.js";
// Type only: a value import from system/ would close a cycle between the subsystems (daemon-boundaries).
import { type Chore, DAY_MS } from "../../system/chore-clock.js";
import { overlaysDir, overlaysRoot } from "./isolation.js";

// CHECKOUTS AND OVERLAYS NO CONVERSATION OWNS (2026-10-05). A discard or purge removes a conversation's checkout and
// its dependency overlays before its rows (worktrees.ts `remove`), so a directory under /history/worktrees or
// /history/overlays that no conversation names is one a crash left between the two, or one a lost database stopped
// naming. The boot's worktree sweep only logged the first kind and never looked at the second. Daily, each is judged
// against the registry: one it does not know, untouched for a day, is reclaimed. An overlay holds only what a turn
// wrote over the main tree's node_modules, so it is removed; a checkout may hold uncommitted work, so it moves to the
// trash, which system/resources/storage/trash-sweep.ts empties after its while. Nothing is judged while the registry
// cannot be trusted to name every conversation: a database made again this boot, one that names none, or a registry
// that loaded none.

export const ORPHAN_MIN_AGE_MS = DAY_MS;

// How deep below a directory its last change is looked for: a checkout's top two levels, an overlay's layers.
const CHANGE_DEPTH = 2;

// What the registry says of a directory's conversation. `unknown` when asking it failed.
export type Ownership = "owned" | "unowned" | "unknown";

// `young`: no conversation owns it, but something changed in it within the day, which is what a conversation being
// opened looks like.
export type OrphanVerdict = "keep" | "unknown" | "young" | "reclaim";

export const orphanVerdict = (ownership: Ownership, ageMs: number, minAgeMs: number = ORPHAN_MIN_AGE_MS): OrphanVerdict => {
    if (ownership !== "unowned") {
        return ownership === "owned" ? "keep" : "unknown";
    }
    return ageMs < minAgeMs ? "young" : "reclaim";
};

// Why the registry cannot answer for the directories standing; undefined when it can.
export type RegistryHold = "database-recreated" | "database-empty" | "registry-empty";

export interface RegistryState {
    // The database was found missing or damaged and made again this boot: its rows are not the ones these directories
    // were written beside.
    readonly recreated: boolean;
    // Whether the database holds any conversation.
    readonly databaseAny: boolean;
    // How many conversations the registry loaded; none while the database holds some is a load that failed.
    readonly loaded: number;
}

export const registryHold = (state: RegistryState): RegistryHold | undefined => {
    if (state.recreated) {
        return "database-recreated";
    }
    if (!state.databaseAny) {
        return "database-empty";
    }
    return state.loaded === 0 ? "registry-empty" : undefined;
};

export interface OrphanCheckoutsDeps {
    readonly historyRoot: string;
    // Where AgentWorktrees keeps each conversation's checkout: `<historyRoot>/worktrees` (conversations-slice.ts).
    readonly worktreesRoot: string;
    // services.agents, as loaded at boot: archived conversations included, none when its load failed.
    readonly registry: { readonly ids: () => readonly string[] };
    // services.conversationUnits.owners: the database's own answer, which also names rows this build cannot read.
    readonly owners: UnitOwners;
    readonly logger: Pick<Logger, "info" | "warn">;
    readonly now?: () => number;
}

export interface OrphanPass {
    // Set when nothing was judged, and why.
    readonly held?: RegistryHold;
    readonly checkouts: readonly string[];
    readonly overlays: readonly string[];
    // Unowned directories left for being changed within the day, or for an owner the registry could not be asked about.
    readonly young: number;
    readonly unknown: number;
    // Directories judged orphaned that could not be reclaimed, with why; the next pass tries again.
    readonly failed: readonly { readonly dir: string; readonly error: string }[];
}

// Conversation ids with a directory under `root`; anything not named like one is no conversation's and is left alone.
const idsUnder = async (root: string): Promise<string[]> =>
    ((await readdir(root, { withFileTypes: true }).catch(undefinedIfMissing)) ?? [])
        .filter((entry) => entry.isDirectory() && isConversationId(entry.name))
        .map((entry) => entry.name);

// The latest change at or below `path`, `depth` levels down, as mtime or ctime. A walk that fails partway answers
// `now`: a directory changing under the walk is the opposite of abandoned.
const lastChange = async (path: string, depth: number, now: number): Promise<number> => {
    try {
        const info = await lstat(path);
        let latest = Math.max(info.mtimeMs, info.ctimeMs);
        if (depth > 0 && info.isDirectory()) {
            for (const name of await readdir(path)) {
                latest = Math.max(latest, await lastChange(join(path, name), depth - 1, now));
            }
        }
        return latest;
    } catch {
        return now;
    }
};

type Kind = "checkouts" | "overlays";

const reclaim = async (historyRoot: string, kind: Kind, id: string, dir: string, now: number): Promise<void> => {
    if (kind === "overlays") {
        await rm(dir, { recursive: true, force: true });
        return;
    }
    // Stamped like every other entry set aside (history.ts, worktrees.ts), which is what the trash sweep reads.
    const trash = join(historyRoot, "trash");
    await mkdir(trash, { recursive: true });
    await rename(dir, join(trash, `${id}-checkout-${String(now)}`));
};

// Asked per directory at the decision, so a conversation registered since the pass began is never unowned.
const ownershipOf = (deps: OrphanCheckoutsDeps, id: string): Ownership => {
    try {
        return deps.registry.ids().includes(id) || deps.owners.has(id) ? "owned" : "unowned";
    } catch (error) {
        deps.logger.warn({ err: error, id }, "agents: could not ask the registry who owns a checkout, left in place");
        return "unknown";
    }
};

interface PassTally {
    readonly checkouts: string[];
    readonly overlays: string[];
    young: number;
    unknown: number;
    readonly failed: { readonly dir: string; readonly error: string }[];
}

const judgeOne = async (
    deps: OrphanCheckoutsDeps,
    tally: PassTally,
    target: { readonly id: string; readonly kind: Kind; readonly dir: string },
    now: number,
): Promise<void> => {
    const ownership = ownershipOf(deps, target.id);
    // The walk only for a directory nobody owns: an owned or unanswered one stays whatever its age.
    const ageMs = ownership === "unowned" ? now - (await lastChange(target.dir, CHANGE_DEPTH, now)) : 0;
    const verdict = orphanVerdict(ownership, ageMs);
    if (verdict === "young" || verdict === "unknown") {
        tally[verdict] += 1;
        return;
    }
    if (verdict === "keep") {
        return;
    }
    try {
        await reclaim(deps.historyRoot, target.kind, target.id, target.dir, now);
        tally[target.kind].push(target.id);
    } catch (error) {
        tally.failed.push({ dir: target.dir, error: errorMessage(error) });
    }
};

export const sweepOrphanCheckouts = async (deps: OrphanCheckoutsDeps, now: number): Promise<OrphanPass> => {
    const targets = [
        ...(await idsUnder(deps.worktreesRoot)).map((id) => ({ id, kind: "checkouts" as const, dir: join(deps.worktreesRoot, id) })),
        ...(await idsUnder(overlaysRoot(deps.historyRoot))).map((id) => ({ id, kind: "overlays" as const, dir: overlaysDir(deps.historyRoot, id) })),
    ];
    const tally: PassTally = { checkouts: [], overlays: [], young: 0, unknown: 0, failed: [] };
    if (targets.length === 0) {
        return tally;
    }
    const held = registryHold({ recreated: deps.owners.recreated, databaseAny: deps.owners.any(), loaded: deps.registry.ids().length });
    if (held !== undefined) {
        return { ...tally, held };
    }
    for (const target of targets) {
        await judgeOne(deps, tally, target, now);
    }
    return tally;
};

// Daily; root-scoped like the boot's worktree sweep.
export const orphanCheckoutsChore = (deps: OrphanCheckoutsDeps): Chore => ({
    name: "orphan-checkouts",
    everyMs: DAY_MS,
    run: async () => {
        const pass = await sweepOrphanCheckouts(deps, (deps.now ?? Date.now)());
        if (pass.held !== undefined) {
            deps.logger.warn({ held: pass.held }, "agents: the registry cannot say who owns the checkouts and overlays on disk, none is judged");
            return;
        }
        if (pass.failed.length > 0) {
            deps.logger.warn(
                { count: pass.failed.length, first: pass.failed[0] },
                "agents: some checkouts or overlays no conversation owns could not be reclaimed",
            );
        }
        if (pass.checkouts.length > 0 || pass.overlays.length > 0) {
            deps.logger.info(
                { checkouts: pass.checkouts, overlays: pass.overlays, young: pass.young, unknown: pass.unknown },
                "agents: reclaimed checkouts and overlays no conversation owns (checkouts to the trash, overlays removed)",
            );
        }
    },
});
