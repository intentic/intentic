import type { WorkspaceEvent } from "@intentic/sandbox-contract/schemas/automations";
import type { Services } from "../../../composition.js";
import type { ConversationActors } from "../../../conversations/actor/conversation-actors.js";
import { ROSTER, subagentRunning } from "../../../conversations/actor/subagent-roster.js";
import { holdsChildren, recordedTargetOf } from "../../../conversations/land/land-target.js";
import type { LandStanding } from "../../../conversations/land/standing.js";
import { conversationProfile, isIsolated, type PersistedAgent } from "../../../conversations/registry/agents-store.js";
import { deliverWake } from "../../../seams/wake-delivery.js";
import { CHILDREN, onChildSettled } from "../child-records.js";
import { noteSpawnedChild } from "../subagents.js";

/* A START THAT WAITS FOR ITS SIBLINGS. Parents sequenced their children by hand: one child stopped at its own step 6
   until two sibling slices had landed and its parent had to tell it to go on, another parent held two children back until
   a third had landed, another ran eleven spawns one after another (the shinobi-society audit, 2026-11-19). A spawn may
   now name siblings (`after`): the child is filed at once, pending, and starts by itself only once each of them has
   finished and its work is in the parent's checkout. Its conversation, and so its worktree, opens only then, cut from that
   checkout, so it starts on their work. A sibling whose work is held on its branch (a clash with the parent's edits, or a
   parent that judges its children's work first) keeps it waiting for the parent's merge or settle; one that failed or
   was cancelled keeps it waiting for the parent, since only the parent knows whether the rest still makes sense without
   it. Either way the parent is told, and a message sent to the waiting child starts it at once, its words after its task.
   In this process's memory, rebuilt at boot from the held starts in spawned-children.ts (children.ts resumeHeldChild).
   A sibling's work brought in by the parent's own merge or settle, any land of it (an owner's press on its card
   included), or a sibling's next ending looks again; an owner's "Already merged" press does not, until one of those
   happens. */

type Actors = Pick<ConversationActors, "holdings">;

// The registry as the wait reads it: where each sibling's work stands.
interface AfterAgents {
    readonly entry: (id: string) => PersistedAgent | undefined;
    readonly standingOf: (id: string) => LandStanding;
}

/** How one sibling a child waits for stands: still at work, its work in, its work held off, or ended without it. */
export type Prerequisite =
    | { readonly kind: "working" }
    | { readonly kind: "in" }
    | { readonly kind: "held" }
    | { readonly kind: "ended"; readonly how: "failed" | "was cancelled" | "is gone" };

/** The `after` field's description, the same wherever a spawn takes it. */
export const AFTER_WORDS =
    "Ids of other subagents of yours, as spawn returned them, that must finish first. This one is filed at once and starts " +
    "by itself only once each of them has finished and its work is in your checkout, so its worktree is cut with their work " +
    "in it; until then wait and `agents show` say it is pending after them. If one fails or is cancelled, or its work is " +
    "held on its branch, you are told and this one waits for you: merge or settle the held work, send this one a message " +
    "to start it anyway, or cancel it. Leave it out to start at once.";

const listed = (ids: readonly string[]): string => ids.map((id) => `\`${id}\``).join(", ");

// Whether a parent spawned this id here: its record, or, for a start that never ran and was struck off, its roster row.
const spawnedBy = (actors: Actors, parentId: string, id: string): boolean => {
    const row = actors.holdings(ROSTER).get(id);
    return actors.holdings(CHILDREN).get(id)?.parent === parentId || (row?.kind === "spawned" && row.conversationId === parentId);
};

// A circle among the waits reachable from `from`: the ids around it, or undefined. A spawn names only children that
// exist already, none of which can name the one being spawned, so a spawn cannot close a circle; this guards the waits
// already filed, which a boot rebuilds from files.
const circleFrom = (actors: Actors, from: readonly string[]): readonly string[] | undefined => {
    const visit = (id: string, path: readonly string[]): readonly string[] | undefined => {
        if (path.includes(id)) {
            return [...path.slice(path.indexOf(id)), id];
        }
        for (const next of actors.holdings(CHILDREN).get(id)?.after ?? []) {
            const found = visit(next, [...path, id]);
            if (found !== undefined) {
                return found;
            }
        }
        return undefined;
    };
    return from.map((id) => visit(id, [])).find((found) => found !== undefined);
};

/** Why a spawn's `after` cannot be taken; undefined when every id is a subagent this parent spawned here, in no circle. */
export const afterRefusal = (actors: Actors, parentId: string, after: readonly string[] | undefined): string | undefined => {
    if (after === undefined) {
        return undefined;
    }
    const unknown = after.filter((id) => !spawnedBy(actors, parentId, id));
    if (unknown.length > 0) {
        return `Nothing was started: \`after\` names ${listed(unknown)}, which ${unknown.length === 1 ? "is not a subagent" : "are not subagents"} you spawned in this sandbox. Name only your own subagents' ids, as spawn returned them (\`list\` shows them).`;
    }
    const circle = circleFrom(actors, after);
    return circle === undefined ? undefined : `Nothing was started: \`after\` would wait in a circle (${circle.map((id) => `\`${id}\``).join(" waits after ")}), which never starts.`;
};

// Whether a sibling's finished work is in its parent's checkout, read as its parent's report reads it (child-lands.ts
// childLandingWords): nothing made, or landed there. Held off it: a land that clashed (child-held.ts heldNow), work a
// parent that judges its children first has not merged yet (child-lands.ts heldForParent), or a land that never wrote
// it. A sibling working in the shared tree, or with no record, has nothing on a branch to wait for.
const workIn = (agents: AfterAgents, id: string): boolean => {
    const entry = agents.entry(id);
    if (entry === undefined || !isIsolated(entry)) {
        return true;
    }
    const standing = agents.standingOf(id);
    if (standing === "conflict") {
        return false;
    }
    if ((entry.landing.diff?.files ?? 0) === 0) {
        return true;
    }
    const target = recordedTargetOf(agents, entry);
    const landedHere = target.kind === "parent" ? entry.placement.landedInto === target.parent : entry.placement.repos.some(({ landedTip }) => landedTip !== undefined);
    const judged = target.kind === "parent" && holdsChildren(agents.entry(target.parent)) && (!landedHere || standing === "ready");
    return landedHere && !judged;
};

/** Where one sibling stands, off its record, its roster row and, once it ended well, where its work went. */
export const prerequisiteOf = (actors: Actors, agents: AfterAgents, id: string): Prerequisite => {
    const kid = actors.holdings(CHILDREN).get(id);
    const row = actors.holdings(ROSTER).get(id);
    if (kid !== undefined && (kid.running || kid.held !== undefined || kid.paused !== undefined || kid.movingOn !== undefined)) {
        return { kind: "working" };
    }
    if (row === undefined) {
        return kid === undefined ? { kind: "ended", how: "is gone" } : { kind: "working" };
    }
    if (subagentRunning(row)) {
        return { kind: "working" };
    }
    if (row.status !== "completed") {
        return { kind: "ended", how: row.status === "killed" ? "was cancelled" : "failed" };
    }
    return workIn(agents, id) ? { kind: "in" } : { kind: "held" };
};

/** Whether every sibling named has finished with its work in the parent's checkout. */
export const afterDue = (services: { readonly conversations: Actors; readonly agents: AfterAgents }, after: readonly string[]): boolean =>
    after.every((id) => prerequisiteOf(services.conversations, services.agents, id).kind === "in");

/** What its parent is told of a waiting child its message started before its siblings were done. */
export const AFTER_SKIPPED = "Started now, before the subagents it waited for were done: it opens on its task, then your message, in a worktree cut from your checkout as it stands. Supervise it with wait.";

/** What a waiting child's row says, and its parent is told as it is filed. */
export const afterSummary = (after: readonly string[]): string =>
    `Waiting after ${listed(after)}: it starts by itself once ${after.length === 1 ? "it has" : "each has"} finished and its work is in your checkout, so it starts on that work. Send it a message to start it now; cancel it to drop it.`;

// The words for a sibling that keeps the child waiting until the parent acts: on its row, and said to the parent.
const stuckWords = (id: string, standing: Prerequisite): string =>
    standing.kind === "held"
        ? `\`${id}\`'s work waits on its branch, not in your checkout (a clash with your edits, or work you judge before taking it): it starts once you bring that work in with merge, or say you did with settle`
        : `\`${id}\` ${standing.kind === "ended" ? standing.how : "ended"}, so it does not start by itself: it starts once \`${id}\` finishes with its work in (send \`${id}\` what to do), or when you send it a message`;

/** One child waiting for its siblings. */
export interface AfterWaiter {
    readonly childId: string;
    readonly parent: string;
    readonly after: readonly string[];
    // Starts it now, with the parent's words after its task where a message started it; why not, where it did not.
    readonly start: (message?: string) => Promise<{ readonly ok: boolean; readonly message?: string }>;
}

type AfterServices = Pick<Services, "conversations" | "agents" | "turns" | "logger">;

interface Waiting extends AfterWaiter {
    readonly services: AfterServices;
    // Each sibling and the standing the parent was already told of, so news is said once.
    readonly told: Map<string, Prerequisite["kind"]>;
    // What its row says now, so a look that changes nothing writes nothing.
    summary: string;
}

const WAITING = new Map<string, Waiting>();
let listening: (() => void) | undefined;

// Said into the parent's live turn, else a turn of its own: only the parent can unblock the child. Never throws.
const tellParent = async (services: AfterServices, parent: string, words: string): Promise<void> => {
    const entry = services.agents.entry(parent);
    if (entry === undefined || entry.archivedAt !== undefined) {
        return;
    }
    try {
        await deliverWake({ turns: services.turns }, { conversationId: parent, prompt: words, voice: "sandbox", source: "subagents", profile: conversationProfile(entry) });
    } catch (error) {
        services.logger.warn({ err: error, parent }, "subagents: a child waiting for its siblings could not be said to its parent");
    }
};

// Starts the child once every sibling's work is in; else keeps its row saying what holds it, and answers what newly
// keeps it waiting for its parent (said once per sibling and standing), or undefined when nothing new does.
const look = (waiting: Waiting): string | undefined => {
    if (WAITING.get(waiting.childId) !== waiting) {
        return undefined;
    }
    const { services } = waiting;
    const standings = waiting.after.map((id) => [id, prerequisiteOf(services.conversations, services.agents, id)] as const);
    if (standings.every(([, standing]) => standing.kind === "in")) {
        WAITING.delete(waiting.childId);
        void waiting.start();
        return undefined;
    }
    const stuck = standings.filter(([, standing]) => standing.kind === "held" || standing.kind === "ended");
    const news = stuck.filter(([id, standing]) => waiting.told.get(id) !== standing.kind);
    for (const [id, standing] of standings) {
        waiting.told.set(id, standing.kind);
    }
    const summary =
        stuck.length === 0
            ? afterSummary(waiting.after)
            : `Waiting after ${listed(waiting.after)}: ${stuck.map(([id, standing]) => stuckWords(id, standing)).join("; ")}. Send it a message to start it now, or cancel it.`;
    if (summary !== waiting.summary) {
        waiting.summary = summary;
        noteSpawnedChild(services.conversations, waiting.childId, { status: "pending", summary });
    }
    return news.length === 0 ? undefined : news.map(([id, standing]) => stuckWords(id, standing)).join("; ");
};

// What the parent is told of a waiting child that now waits for it.
const stuckNews = (services: AfterServices, waiting: AfterWaiter, news: string): string => {
    const task = services.conversations.holdings(ROSTER).get(waiting.childId)?.description;
    return `Your subagent \`${waiting.childId}\`${task === undefined ? "" : ` ("${task}")`} waits after ${listed(waiting.after)}, and ${news}. To start it now anyway, send it a message: it opens on its task, then your words. To drop it, cancel it.`;
};

// Every child waiting after this sibling, looked at again once the step that moved it is over.
const recheck = (siblingId: string): void => {
    queueMicrotask(() => {
        for (const waiting of [...WAITING.values()].filter((each) => each.after.includes(siblingId))) {
            const news = look(waiting);
            if (news !== undefined) {
                void tellParent(waiting.services, waiting.parent, stuckNews(waiting.services, waiting, news));
            }
        }
    });
};

/**
 * Files a child to start once its siblings are done, and looks at once. What already keeps it waiting for its parent is
 * said to the parent (`sayNow`, a start nobody is answering), or answered for the caller to say (a spawn's own answer).
 */
export const waitForSiblings = (services: AfterServices, waiter: AfterWaiter, sayNow: boolean): string | undefined => {
    listening ??= onChildSettled((childId) => recheck(childId));
    const waiting: Waiting = { ...waiter, services, told: new Map(), summary: afterSummary(waiter.after) };
    WAITING.set(waiter.childId, waiting);
    const news = look(waiting);
    if (news === undefined || !sayNow) {
        return news;
    }
    void tellParent(services, waiter.parent, stuckNews(services, waiter, news));
    return undefined;
};

/** Work reached a tree (a parent's merge, an owner's press of Land or Merge on the card): whoever waits after it looks again. */
export const afterLanded = (event: WorkspaceEvent): void => {
    if (event.event === "agent.landed") {
        recheck(event.agentId);
    }
};

/** A sibling's held work was brought in (merge or settle): whoever waits after it looks again. Passes `result` through. */
export const afterMoved =
    (siblingId: string) =>
    <T>(result: T): T => {
        recheck(siblingId);
        return result;
    };

/** Takes a waiting child off the wait (its parent cancelled it); whether it was waiting. */
export const withdrawAfter = (childId: string): boolean => WAITING.delete(childId);

/** Starts a waiting child now, its parent's words after its task; undefined when it was not waiting. */
export const startAfterNow = (childId: string, message: string): ReturnType<AfterWaiter["start"]> | undefined => {
    const waiting = WAITING.get(childId);
    if (waiting === undefined) {
        return undefined;
    }
    WAITING.delete(childId);
    return waiting.start(message);
};

/** For a suite: nothing waits. */
export const resetAfterForTest = (): void => WAITING.clear();
