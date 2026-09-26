import type { MainlineRouting, WorkspaceEvent } from "@intentic/sandbox-contract";
import type { Services } from "../../composition.js";
import { parentOfActor } from "../../auth/principal.js";
import { conversationProfile } from "../../conversations/registry/agents-store.js";
import { deliverWake } from "../run/turn/wake-delivery.js";

// What becomes of a child's work after its turn ends is its parent's news while the parent still supervises: the work
// landed, a land hit a conflict, or the main tree's own check went red on it and the red was routed somewhere. A parent
// sequencing its next step on those found them by polling `agents show`, git and the check's log, and relayed failures
// the router had already sent back to the child. Said into the parent's live turn, where a parked wait hands the turn
// back for them. A parent with no live turn is not woken: its supervising is over, and the owner is the one landing.

// Who started a conversation and on what it runs, whether its parent has a live turn, and the door words go through.
export interface ChildNewsDeps {
    readonly agents: Pick<Services["agents"], "entry">;
    readonly conversations: Pick<Services["conversations"], "running" | "sessionIdOf">;
    readonly turns: Pick<Services["turns"], "say">;
    readonly logger: Pick<Services["logger"], "info" | "warn">;
}

// What the parent's chat names as having spoken.
const SOURCE = "child agents";

// Paths a conflict note names before counting the rest.
const PATHS_NAMED = 5;
// Failures a red note names before counting the rest.
const FAILURES_NAMED = 3;

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
// queued behind a turn that takes no words. Never throws: it runs off a land or a check, which must not fail with it.
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
export const bookedRerunWords = (rerun: { readonly at?: number | undefined }): string =>
    `The sandbox runs this same turn again by itself${rerun.at === undefined ? " shortly" : ` at ${new Date(rerun.at * 1000).toISOString().slice(11, 16)} UTC`}, and its report reaches you when that ends: do not send it the task again or give the task to another agent meanwhile.`;

/** A child's work reached the main tree: its parent hears so, and that a red on it is routed without its help. */
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
        [
            `Your child agent ${supervisor.name} landed in the main tree${repos.length === 0 ? "" : ` (${listed(repos, repos.length)})`}.`,
            "The main tree's own check runs on it next. If that goes red on this land you are told where its failures were sent, so leave them to that instead of relaying them yourself.",
        ].join(" "),
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
            `The owner pressed Land on your child agent ${supervisor.name}, and it hit a merge conflict${paths.length === 0 ? "" : ` on ${listed(paths, PATHS_NAMED)}`}: nothing of it reached the main tree.`,
            "It lands once its branch is rebased onto the main line and the conflicts are resolved. The owner can have it do that from its card, or you can tell it to; a message you send while another turn runs on it waits for that turn to end.",
        ].join(" "),
    );
};

// Lower-cases a sentence's first letter, to carry a routing's own detail on after a colon.
const continued = (sentence: string): string => `${sentence.charAt(0).toLowerCase()}${sentence.slice(1)}`;

// What a parent should do about failures somebody else now owns, and about ones nobody does.
const LEAVE_IT = "Leave them to that instead of relaying them yourself.";
const YOURS = "Fixing it is for you or the owner to arrange.";

// Where a red's failures went, in words for the parent of work that landed; undefined for a decision that sends nobody
// yet and settles nothing (the next check decides), which a later decision reports instead.
export const routedWords = (routing: MainlineRouting): string | undefined => {
    switch (routing.kind) {
        case "original":
            return routing.conversationId === undefined
                ? undefined
                : `They were sent back to \`${routing.conversationId}\` to fix in a turn of its own; you get its report when that ends. ${LEAVE_IT}`;
        case "fix-up":
            return routing.conversationId === undefined
                ? undefined
                : `They were handed to a fresh conversation, \`${routing.conversationId}\`, which fixes them in a worktree of its own. ${LEAVE_IT}`;
        case "held":
            return `Nobody is sent yet: ${continued(routing.detail ?? "a conversation still working touches what failed.")} ${LEAVE_IT}`;
        case "spent":
            return `Nobody more is sent: ${continued(routing.detail ?? "the sends and fresh attempts this red allows are used up.")} ${YOURS}`;
        case "reported":
            return `Nobody was sent: ${continued(routing.detail ?? "no conversation could take it.")} ${YOURS}`;
        case "waiting":
        case "resolved":
        case "dismissed":
            return undefined;
    }
};

// Each red decision a parent was told, so a red re-routed on every run of a long streak tells it once per decision.
// Bounded, oldest forgotten first: a forgotten decision can at worst be told twice.
const told = new Set<string>();
const TOLD_KEPT = 500;

const firstTelling = (key: string): boolean => {
    if (told.has(key)) {
        return false;
    }
    told.add(key);
    if (told.size > TOLD_KEPT) {
        const [oldest] = told;
        if (oldest !== undefined) {
            told.delete(oldest);
        }
    }
    return true;
};

/**
 * The main tree's own check went red on work that landed, and the router decided where the failures go: each parent with
 * a child among the lands it was laid at hears which children, a few of the failures, and where they went. One note per
 * parent and decision.
 */
export const reportChildrenRed = async (
    deps: ChildNewsDeps,
    red: { readonly project: string; readonly redSince: number; readonly fresh: readonly string[] },
    suspects: readonly string[],
    routing: MainlineRouting,
): Promise<void> => {
    const words = routedWords(routing);
    if (words === undefined) {
        return;
    }
    const byParent = new Map<string, string[]>();
    for (const childId of new Set(suspects)) {
        const supervisor = supervisorOf(deps, childId);
        if (supervisor !== undefined) {
            byParent.set(supervisor.parent, [...(byParent.get(supervisor.parent) ?? []), supervisor.name]);
        }
    }
    const where = red.project === "" ? "the workspace root" : `\`${red.project}\``;
    for (const [parent, names] of byParent) {
        if (!firstTelling([red.project, red.redSince, parent, routing.kind, routing.conversationId ?? ""].join("\n"))) {
            continue;
        }
        await tell(
            deps,
            parent,
            [
                `The main tree's own check in ${where} went red after work from your child agent${names.length === 1 ? "" : "s"} ${names.join(", ")} landed: ${red.fresh.length} new failure${red.fresh.length === 1 ? "" : "s"}${red.fresh.length === 0 ? "" : `, such as ${listed(red.fresh, FAILURES_NAMED)}`}.`,
                words,
            ].join(" "),
        );
    }
};

// Test seam: forgets which red decisions were told.
export const resetChildNews = (): void => {
    told.clear();
};
