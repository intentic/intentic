import type { LandConflict, WorkspaceEvent } from "@intentic/sandbox-contract";
import type { Services } from "../../composition.js";
import { parentOfActor } from "../../auth/principal.js";
import { recordedTargetOf } from "../../conversations/land/land-target.js";
import { conversationProfile, isIsolated, type PersistedAgent } from "../../conversations/registry/agents-store.js";
import { deliverWake } from "../run/turn/wake-delivery.js";

// What becomes of a child's work after its turn ends is its parent's news while the parent still supervises: the work
// landed, or a land hit a conflict. A parent sequencing its next step on those found them by polling `agents show` and
// git. Said into the parent's live turn, where a parked wait hands the turn back for them. A parent with no live turn is
// not woken: its supervising is over, and the owner is the one landing.

// Who started a conversation and on what it runs, whether its parent has a live turn, and the door words go through.
export interface ChildNewsDeps {
    readonly agents: Pick<Services["agents"], "entry">;
    readonly conversations: Pick<Services["conversations"], "running" | "sessionIdOf">;
    readonly turns: Pick<Services["turns"], "say">;
    readonly logger: Pick<Services["logger"], "info" | "warn">;
}

// What the parent's chat names as having spoken.
const SOURCE = "subagents";

// Paths a conflict note names before counting the rest.
const PATHS_NAMED = 5;

const nameOf = (childId: string, title: string | undefined): string => (title === undefined ? `\`${childId}\`` : `\`${childId}\` ("${title}")`);

const listed = (items: readonly string[], named: number): string =>
    [
        items
            .slice(0, named)
            .map((item) => `\`${item}\``)
            .join(", "),
        ...(items.length > named ? [`and ${items.length - named} more`] : []),
    ].join(" ");

// The parent that started this conversation, while that parent has a live turn to hear news in.
const supervisorOf = (deps: ChildNewsDeps, childId: string): { readonly parent: string; readonly name: string } | undefined => {
    const entry = deps.agents.entry(childId);
    const parent = parentOfActor(entry?.identity.startedBy);
    if (parent === undefined || !deps.conversations.running(parent)) {
        return undefined;
    }
    return { parent, name: nameOf(childId, entry?.social.title?.text) };
};

// Says it into the parent's turn: whether the parent has it now (said into its turn, or a turn of its own), not merely
// queued behind a turn that takes no words. Never throws: it runs off a land, which must not fail with it.
const tell = async (deps: ChildNewsDeps, parent: string, prompt: string): Promise<boolean> => {
    const entry = deps.agents.entry(parent);
    if (entry === undefined || entry.archivedAt !== undefined) {
        return false;
    }
    try {
        const receipt = await deliverWake(
            { turns: deps.turns, sessionIdOf: (conversationId) => deps.conversations.sessionIdOf(conversationId) },
            { conversationId: parent, prompt, voice: "sandbox", source: SOURCE, profile: conversationProfile(entry) },
        );
        if ("invalid" in receipt || "why" in receipt) {
            deps.logger.info({ parent, receipt }, "child news: the parent took nothing");
            return false;
        }
        return receipt.delivered !== "queued";
    } catch (error) {
        deps.logger.warn({ err: error, parent }, "child news: could not be said to the parent");
        return false;
    }
};

/** Says news about one of its children into a parent's live turn; nothing when it has none. Whether the parent has it. */
export const sayToParent = async (deps: ChildNewsDeps, parent: string, prompt: string): Promise<boolean> =>
    deps.conversations.running(parent) ? tell(deps, parent, prompt) : false;

/**
 * What a child's failure tells its parent when the sandbox booked a re-run of that same turn, so the parent neither
 * sends the task again nor hands it to another agent. `at` is when it fires, in epoch seconds, where one is known.
 */
export const bookedRerunWords = (rerun: { readonly at?: number | undefined }, child?: string): string =>
    `The sandbox runs this same turn again by itself${rerun.at === undefined ? " shortly" : ` at ${new Date(rerun.at * 1000).toISOString().slice(11, 16)} UTC`}, and its report reaches you when that ends: do not send it the task again or give the task to another agent meanwhile.${
        child === undefined ? "" : ` To have it not run again, cancel it (the cancel tool, or \`agents cancel ${child}\`), then decide yourself.`
    }`;

// A conflict report's paths as a parent names them: workspace-relative, a nested repo's under its folder.
const conflictPaths = (conflicts: readonly LandConflict[]): string[] =>
    conflicts.flatMap(({ repo, paths }) => paths.map(({ path }) => (repo === "root" ? path : `${repo}/${path}`)));

/**
 * Where a settled child's work went, as its parent reads it beside the report: in the parent's own checkout, as an
 * in-process subagent's edits are, or held off it by a clash with the parent's edits, with the door that brings it in.
 * Undefined for a child that lands as any conversation does (its parent cannot take its work), and for one whose
 * turn left nothing to bring.
 */
export const childLandingWords = (agents: { readonly entry: (id: string) => PersistedAgent | undefined }, childId: string): string | undefined => {
    const child = agents.entry(childId);
    if (child === undefined || !isIsolated(child)) {
        return undefined;
    }
    const target = recordedTargetOf(agents, child);
    if (target.kind === "main" && target.ruled) {
        return undefined;
    }
    const where = target.kind === "parent" ? "your checkout" : "the main tree you work in";
    const clashing = conflictPaths(child.landing.conflicts ?? []);
    if (clashing.length > 0) {
        return `Its changes clash with the edits in ${where} on ${listed(clashing, PATHS_NAMED)}, so nothing of them was written there: they wait on its branch. Bring them in with conflict markers to resolve yourself (the merge tool, or \`agents merge ${childId}\` from a shell), or leave them.`;
    }
    const landedHere = target.kind === "parent" ? child.placement.landedInto === target.parent : child.placement.repos.some(({ landedTip }) => landedTip !== undefined);
    if (!landedHere || (child.landing.diff?.files ?? 0) === 0) {
        return undefined;
    }
    const files = child.landing.diff?.files ?? 0;
    return `Its changes (${files} file${files === 1 ? "" : "s"}) are in ${where} now, uncommitted, as an in-process subagent's edits would be: read them there before you build on them.`;
};

/** A child's work reached the main tree: its parent hears so. */
export const reportChildLanded = async (deps: ChildNewsDeps, event: WorkspaceEvent): Promise<void> => {
    if (event.event !== "agent.landed" || event.outcome !== "landed") {
        return;
    }
    const supervisor = supervisorOf(deps, event.agentId);
    if (supervisor === undefined) {
        return;
    }
    const repos = event.repos.map(({ repo }) => repo);
    await tell(
        deps,
        supervisor.parent,
        `Your subagent ${supervisor.name} landed in the main tree${repos.length === 0 ? "" : ` (${listed(repos, repos.length)})`}.`,
    );
};

/** A press of Land on a child hit a conflict: nothing reached the main tree, and its parent may be sequencing on it. */
export const reportChildConflict = async (deps: ChildNewsDeps, childId: string, paths: readonly string[]): Promise<void> => {
    const supervisor = supervisorOf(deps, childId);
    if (supervisor === undefined) {
        return;
    }
    await tell(
        deps,
        supervisor.parent,
        [
            `The owner pressed Land on your subagent ${supervisor.name}, and it hit a merge conflict${paths.length === 0 ? "" : ` on ${listed(paths, PATHS_NAMED)}`}: nothing of it reached the main tree.`,
            "It lands once its branch is rebased onto the main line and the conflicts are resolved. The owner can have it do that from its card, or you can tell it to; a message you send while another turn runs on it waits for that turn to end.",
        ].join(" "),
    );
};
