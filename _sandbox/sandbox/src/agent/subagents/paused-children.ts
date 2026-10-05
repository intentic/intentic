import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import { parentOfActor } from "../../auth/principal.js";
import type { Services } from "../../composition.js";
import { defineDocument } from "../../store/evolution/documents.js";
import { openDocument } from "../../store/open-document.js";
import { type ChildNewsDeps, sayToParent } from "./child-lands.js";

// A paused child's end check, across a restart. A spawned child whose turn ended on a wall the sandbox re-runs it past by
// itself (a spent allowance, a turn that stopped short) is paused, not finished, and its parent was told not to send the
// task again because the re-run is coming. The check that ends the pause as failed when the re-run does not come runs in
// this process (children.ts pauseChild), and the booking the re-run fires from is this process's memory too, which a
// restart clears. So after a restart the parent waited on a re-run nothing would make, and nobody said so. Each pause is
// written down here while it stands, and the next boot tells the parent of every pause the restart cut that its child
// stays stopped.

const PausedChildSchema = z.object({
    // The conversation that spawned it, the one the pause's end is news for.
    parent: z.string(),
    // What stopped its turn, as its parent was told.
    failure: z.string(),
    // When the pause began, and which daemon process it began in: a boot acts only on pauses an earlier process left.
    at: z.number(),
    boot: z.string(),
});
export type PausedChild = z.infer<typeof PausedChildSchema>;

export const pausedChildrenDocument = defineDocument({
    root: "history",
    path: "paused-children.json",
    schema: PausedChildSchema,
    granularity: "record",
});

// This process, as the pauses it writes name it.
const THIS_BOOT = randomUUID();

export interface PausedChildren {
    // Neither write throws: each runs off a child's turn ending or a cancel, which must not fail with it.
    readonly note: (childId: string, pause: Pick<PausedChild, "parent" | "failure">, now: number) => Promise<void>;
    readonly forget: (childIds: readonly string[]) => Promise<void>;
    readonly read: () => Promise<Readonly<Record<string, PausedChild>>>;
}

// Opened wherever it is needed: every handle on the path shares its write queue, so a note and the forget after it land
// in the order they were made.
export const filePausedChildren = (historyRoot: string, logger: Pick<Logger, "warn">): PausedChildren => {
    const file = openDocument(pausedChildrenDocument, join(historyRoot, pausedChildrenDocument.path), {
        fallback: (): Record<string, PausedChild> => ({}),
    });
    return {
        note: async (childId, pause, now) => {
            try {
                await file.update((current) => ({
                    ...current,
                    [childId]: { parent: pause.parent, failure: pause.failure, at: now, boot: THIS_BOOT },
                }));
            } catch (error) {
                logger.warn(
                    { err: error, child: childId },
                    "subagents: a child's pause could not be written down, a restart before its re-run tells its parent nothing",
                );
            }
        },
        forget: async (childIds) => {
            if (childIds.length === 0) {
                return;
            }
            const gone = new Set(childIds);
            try {
                await file.update((current) =>
                    Object.keys(current).some((id) => gone.has(id))
                        ? Object.fromEntries(Object.entries(current).filter(([id]) => !gone.has(id)))
                        : current,
                );
            } catch (error) {
                logger.warn(
                    { err: error, children: childIds },
                    "subagents: an ended pause could not be struck off, the next boot may tell its parent again",
                );
            }
        },
        read: () => file.read(),
    };
};

// What a boot does with one written-down pause: leave one this process wrote, which its own check still covers; tell the
// parent that its child stays stopped; or let it go with nothing to say, and why.
export type RestartPauseFate =
    { readonly kind: "keep" } | { readonly kind: "tell"; readonly parent: string } | { readonly kind: "drop"; readonly why: string };

// What the boot reads of the two conversations, now.
export interface RestartPauseFacts {
    // Undefined once the child's conversation is gone; `parent` is who spawned it, per the registry.
    readonly child: { readonly parent: string | undefined; readonly running: boolean } | undefined;
    // Undefined once the parent's conversation is gone.
    readonly parent: { readonly archived: boolean; readonly running: boolean } | undefined;
}

/**
 * The boot's decision for one pause. Every booking a restart cuts is gone, so a pause an earlier process left never ends
 * in its re-run: its parent hears so, where it has a live turn to hear it in, as it would have from the check that the
 * restart cut short (sayToParent tells nobody else either). A child running again needs no word: that turn's ending reaches
 * its parent like any other.
 */
export const restartPauseFate = (pause: PausedChild, facts: RestartPauseFacts, boot: string = THIS_BOOT): RestartPauseFate => {
    if (pause.boot === boot) {
        return { kind: "keep" };
    }
    if (facts.child === undefined) {
        return { kind: "drop", why: "the child's conversation is gone" };
    }
    if (facts.child.parent !== pause.parent) {
        return { kind: "drop", why: "the registry names another parent" };
    }
    if (facts.child.running) {
        return { kind: "drop", why: "a turn runs on the child again, and its ending reaches the parent" };
    }
    if (facts.parent === undefined) {
        return { kind: "drop", why: "the parent's conversation is gone" };
    }
    if (facts.parent.archived) {
        return { kind: "drop", why: "the parent is archived" };
    }
    return facts.parent.running ? { kind: "tell", parent: pause.parent } : { kind: "drop", why: "the parent has no live turn to hear it in" };
};

/** What the parent is told: the same ending the check would have given it, with why the re-run never comes. */
export const restartPauseWords = (childId: string, title: string | undefined, failure: string): string =>
    `Your subagent \`${childId}\`${title === undefined ? "" : ` ("${title}")`} stays stopped: ${failure} The sandbox restarted before the re-run it had booked for it, and a restart drops that booking, so it is not coming back by itself: send it again, or give the task to another agent.`;

export interface RestartPauseDeps extends ChildNewsDeps {
    readonly config: Pick<Services["config"], "historyRoot">;
}

const factsOf = (deps: RestartPauseDeps, childId: string, parentId: string): RestartPauseFacts => {
    const child = deps.agents.entry(childId);
    const parent = deps.agents.entry(parentId);
    return {
        child: child === undefined ? undefined : { parent: parentOfActor(child.identity.startedBy), running: deps.conversations.running(childId) },
        parent: parent === undefined ? undefined : { archived: parent.archivedAt !== undefined, running: deps.conversations.running(parentId) },
    };
};

/**
 * At boot, once the turns the restart cut are resumed: strikes off every pause an earlier process left, then tells each
 * parent that is to hear it that its child stays stopped. Struck off first, so a boot that dies half-way never tells a
 * parent twice. Never throws.
 */
export const settleRestartPauses = async (deps: RestartPauseDeps): Promise<void> => {
    try {
        const ledger = filePausedChildren(deps.config.historyRoot, deps.logger);
        const decided = Object.entries(await ledger.read()).map(([childId, pause]) => ({
            childId,
            pause,
            fate: restartPauseFate(pause, factsOf(deps, childId, pause.parent)),
        }));
        const settled = decided.filter(({ fate }) => fate.kind !== "keep");
        await ledger.forget(settled.map(({ childId }) => childId));
        for (const { childId, pause, fate } of settled) {
            if (fate.kind === "drop") {
                deps.logger.info(
                    { child: childId, parent: pause.parent, why: fate.why },
                    "subagents: a pause the restart cut, struck off with no word to its parent",
                );
            } else if (fate.kind === "tell") {
                const title = deps.agents.entry(childId)?.social.title?.text;
                const told = await sayToParent(deps, fate.parent, restartPauseWords(childId, title, pause.failure));
                deps.logger.info(
                    { child: childId, parent: fate.parent, told },
                    "subagents: a pause the restart cut, its parent told the child stays stopped",
                );
            }
        }
    } catch (error) {
        deps.logger.warn({ err: error }, "subagents: the pauses a restart cut could not be settled, their parents are not told");
    }
};
