import type { AgentSummary } from "@intentic/sandbox-contract";
import { errorMessage } from "@intentic/ui/async";
import { computed, ref } from "vue";
import { forgetClosedDraft } from "../../chat/drafts/closedDrafts";
import { useChat } from "../../chat/run/useChat";
import { commandShortcut } from "../../../shell/commands/useCommands";
import { useNotifications } from "../../../shell/notifications/notifications";
import { sandboxJson } from "../../sandbox/client/sandboxClient";
import { jsonBody } from "../../sandbox/client/jsonBody";
import { lanes } from "./useAgents-fleet";
import { archived, holdPending, takeOffBoard } from "./useAgents-registry";

/* --- Archive ---------------------------------------------------------------------------------------------
 * The board's exit. Archiving takes an agent off the lanes and reclaims its worktree checkout, keeping the
 * branch, the transcript and every counter, so it is the ROUTINE action (no confirmation, undoable, bulk),
 * and discard stays the destructive one. See the daemon's agents/archive.ts for what it actually costs.
 *
 * Archiving TAKES THE AGENT'S CHAT TAB WITH IT. One agent is one thing under two skins, a card on the board and
 * a tab in the strip, so filing it away has to move both, or the strip keeps a row for work the board says is
 * over and the user is left closing everything twice. Nothing is lost with the tab: the transcript, the branch
 * and the diff all survive daemon-side, and opening the agent from the archive brings the tab straight back.
 *
 * The undo does NOT reopen what it closed. It puts the CARD back, which is the thing the archive took away,
 * and opening a chat is the user's own action, one click from the restored card. Reopening tabs on the user's
 * behalf would also have to guess which of a swept dozen were open before, and be wrong about most of them.
 *
 * A tab CAN still show an archived agent: reading one from the archive view opens it by design, and a follow-up
 * message un-archives it (see the daemon's registry.begin). Such a tab says what it is, with the way back on it
 * (ChatTabs, ChatPanel), and if the user has started WRITING in it, its card comes back to the board for as
 * long as those words are there (see `fleet`).
 *
 * The list itself, and the pull that fills it (loadArchived), live beside the roster in useAgents-registry. */

/* --- What an archive says ------------------------------------------------------------------------------------
 * Feedback proportional to consequence. Archiving is the action a user performs dozens of times a session, and
 * it is lossless (branch, transcript and counters all stay), so what it says has to be worth what it costs:
 *
 *   · ONE card archived → nothing. The card visibly leaves its lane and the Finished header's archive counter
 *     ticks up, so a strip that repeats the animation is chrome paid for on every press and read on none. It
 *     also SHIFTED the board, which is how a routine action came to feel like an interruption.
 *   · A BULK sweep      → a receipt, because the thing that vouches for a single archive, watching the card
 *     go, is exactly what clearing twelve at once denies you. It floats over the board instead of shifting
 *     it, and it retires itself.
 *   · A FAILURE         → the persistent strip. An error has to be read, so it must not expire on a timer.
 *
 * None of them OWNS the undo. The way back is a fact about the store (`undoable`), so Mod+Z reaches the last
 * archive whether a receipt was ever raised or has long since faded.
 *
 * THE RECEIPT IS THE APP'S, NOT THE BOARD'S. This module used to keep a second copy of the whole idea — its own
 * `FleetReceipt` type, its own ref, and a pill in AgentsView with its own dwell timer and its own transition
 * CSS — sitting forty lines from the shared one it was cloned from and drifting from it. There is one receipt
 * channel now (composables/notifications.ts) and this reports into it like every other completion in the app. */

// The board's must-read strip: an action that failed (a drop, an archive, a restore). No timer, an error the
// user never saw is one that surprises them later. In flow, in the board's own column: it is about THIS view
// and it waits to be read, which is the two things the floating lane is not for.
export const notice = ref<string | undefined>(undefined);

const { say } = useNotifications();

// What the Undo beside a sweep's receipt says on hover. Mod+Z does the same thing from anywhere on the board,
// and a user who learns it from the tooltip stops needing the button.
const undoHint = (): string => {
    const shortcut = commandShortcut(`agents.undoArchive`);
    return shortcut === undefined ? `Put them back on the board` : `Put them back on the board (${shortcut})`;
};

// The ids an undo would put back. Consecutive archives MERGE: clicking down the Finished lane is one intent,
// and a stack remembering only the newest press would silently drop the way back to everything before it,
// which is the whole reason archiving is allowed to skip its confirmation. Unbounded in time on purpose: undo
// means "undo what I did", and putting a card back costs no more than taking it off did.
export const undoable = ref<readonly string[]>([]);

// Bumped by every archive that moved something, the ambient signal the archive counter pulses on. A counter
// rather than a flag because it is the EVENT that matters: two archives in a row owe the user two pulses.
export const archivedFlash = ref(0);

// Which cards are mid-action. A COUNTER per id, not a list: archiving is something the user does card by card
// as fast as they can click, so two calls overlap constantly, and a shared "the ids in flight" ref meant the
// first one to finish cleared the second one's spinner, the card went quiet while its request was still open.
// Each call now releases only what it claimed.
const busyCounts = ref<ReadonlyMap<string, number>>(new Map());
export const busyIds = computed(() => [...busyCounts.value.keys()]);
const claimBusy = (ids: readonly string[]): (() => void) => {
    const claimed = new Map(busyCounts.value);
    for (const id of ids) {
        claimed.set(id, (claimed.get(id) ?? 0) + 1);
    }
    busyCounts.value = claimed;
    return () => {
        const next = new Map(busyCounts.value);
        for (const id of ids) {
            const held = (next.get(id) ?? 0) - 1;
            if (held > 0) {
                next.set(id, held);
            } else {
                next.delete(id);
            }
        }
        busyCounts.value = next;
    };
};

export const dismissNotice = (): void => {
    notice.value = undefined;
};

// Archive the named agents, or, with no ids, every finished agent that is archivable right now (the lane
// header's "Clear"). The daemon answers with the agents that actually moved: "everything finished" cannot be
// re-derived once the lane is empty, and the summaries are what the archive list renders.
export const archive = async (ids?: readonly string[]): Promise<void> => {
    // The bulk press has no ids of its own, so it borrows the lane's, the Finished lane IS the archivable set
    // (it is landed-or-idle by construction), so this is the same set the daemon will pick, and any card it
    // declines is handed back by the rollback below.
    const aimed = ids ?? lanes.value.finished.map((agent) => agent.id);
    const release = claimBusy(aimed);
    // A sweep is the archive with no per-card animation to vouch for it, so it is the archive that reports.
    const sweep = ids === undefined || ids.length > 1;
    // The cards leave here, not on the answer, see takeOffBoard for why, and for what `restore` puts back.
    const restore = takeOffBoard(aimed);
    try {
        const { moved, failed, rev } = await sandboxJson<{ moved: AgentSummary[]; failed: { id: string; reason: string }[]; rev: number }>(
            `/agents/archive`,
            jsonBody(`POST`, ids === undefined ? {} : { ids }),
        );
        /* WHAT THE DAEMON REFUSED, said in its own words, on the strip that does not expire. Releasing a working
         * copy is git work and it can fail for good (the repository behind a checkout was deleted from the
         * workspace, a checkout is locked), and those cards stay on the board. This branch is the fix to the
         * report that sent people here: a refusal answered 200 with nothing moved, so the board read it as
         * "there was nothing to archive" and said so, about the very card the user was looking at, every press,
         * with the reason nowhere but the daemon's log. */
        if (failed.length > 0) {
            const first = failed[0];
            notice.value =
                failed.length === 1
                    ? `Couldn't archive that one: ${first?.reason ?? `its working copy could not be released`}`
                    : `Couldn't archive ${failed.length} of them: ${first?.reason ?? `their working copies could not be released`}`;
        }
        if (moved.length === 0) {
            // A press that changed nothing always says so, however few cards it aimed at: silence is the one
            // reading the user can't distinguish from a broken button. And every card it took on spec goes back,
            // because "nothing moved" is exactly the case the optimistic removal guessed wrong about. The
            // "already off the board" reading belongs to the press that found nothing to do and NOTHING ELSE:
            // a refusal has already said its piece above, and it would be contradicted by it.
            restore();
            if (failed.length === 0) {
                say(`Nothing to archive, every finished agent is already off the board.`);
            }
            return;
        }
        // A DELTA, not the roster the daemon happens to hold now: two archives in flight would otherwise race,
        // and the slower response would put the faster one's cards back on the board. Applying only what moved
        // also means the archive list is correct without a second round-trip to re-read it, which matters most
        // for the agent detail page, whose id lookup spans both halves (agentById).
        //
        // Held as a pending move until the daemon publishes a roster at `rev`: the delta alone still lost to any
        // snapshot already in flight, which is how a just-archived card reappeared for a beat (or for good, if
        // nothing changed after it).
        const gone = new Set(moved.map((agent) => agent.id));
        holdPending(
            moved.map((agent) => ({ id: agent.id })),
            rev,
        );
        // …and the rest of what the press aimed at comes back: the removal was taken on spec, and this is the
        // daemon's account of which of it was right.
        restore(gone);
        archived.value = [
            // Object.assign, not a spread, `moved` is this call's own freshly-parsed JSON.
            ...moved.map((agent) => Object.assign(agent, { open: false, unread: false, unsent: false })),
            ...archived.value.filter((agent) => !gone.has(agent.id)),
        ];
        // Archiving several cards in a row is ONE intent, so consecutive archives merge into one undo (see
        // `undoable`). The receipt counts that merged set rather than this press alone, it is the number the
        // Undo beside it would put back, and a receipt whose count disagrees with its own button is a lie.
        undoable.value = [...moved.map((agent) => agent.id), ...undoable.value.filter((id) => !gone.has(id))];
        archivedFlash.value += 1;
        // The board and the strip are two views of one fleet, so the cards that just left take their tabs with
        // them (see the archive note above). Driven off `moved` like every other effect here: a press that aimed
        // at an agent the daemon declined to archive must not close its chat.
        useChat().closeTabs(gone);
        // The archive worked, so whatever failure the strip was still holding is stale, unless THIS press is
        // what put it there: a mixed answer (nine cards away, one refused) has to keep the sentence about the
        // one that stayed, which is the only card on the board the user still has a question about.
        if (failed.length === 0) {
            notice.value = undefined;
        }
        if (sweep) {
            const count = undoable.value.length;
            say(`${count} agent${count === 1 ? `` : `s`} archived`, undoArchive, undoHint());
        }
    } catch (error) {
        // The press failed, so the cards it took slide back into their lane, under the strip that says why.
        restore();
        notice.value = errorMessage(error, `Couldn't archive that.`);
    } finally {
        release();
    }
};

// Put agents back on the board, a per-card restore, and the inverse an archive's undo runs. The checkout is
// not rebuilt here (the daemon does that lazily on the agent's next turn), so this is as cheap for a hundred
// agents as for one.
export const restore = async (ids: readonly string[]): Promise<void> => {
    const release = claimBusy(ids);
    try {
        const { moved, rev } = await sandboxJson<{ moved: AgentSummary[]; rev: number }>(`/agents/unarchive`, jsonBody(`POST`, { ids }));
        // The same delta, in the other direction, and held the same way, so a snapshot in flight can't take the
        // restored card straight back off the board.
        const back = new Set(moved.map((agent) => agent.id));
        archived.value = archived.value.filter((agent) => !back.has(agent.id));
        holdPending(
            moved.map((agent) => ({ id: agent.id, present: agent })),
            rev,
        );
        // What is back on the board is no longer anyone's to undo, including when the user restored it card
        // by card from the archive view rather than through the undo itself.
        undoable.value = undoable.value.filter((id) => !back.has(id));
        say(`${back.size} agent${back.size === 1 ? `` : `s`} back on the board`);
        notice.value = undefined;
    } catch (error) {
        notice.value = errorMessage(error, `Couldn't restore that.`);
    } finally {
        release();
    }
};

/* Empty the archive, the fleet's ONE irreversible action, and the reason the archive is a filing cabinet
 * rather than a one-way door: every other exit on this board keeps the branch, so without this the only way to
 * ever get rid of an agent was to discard it card by card before it was archived.
 *
 * Everything about it is the inverse of `archive`'s grammar, and deliberately so:
 *   · it CONFIRMS first (the view's dialog), there is no undo to fall back on
 *   · it always reports, even for one agent, and the receipt carries NO Undo. The missing button is the honest
 *     signal that this press was not like the archiving that precedes it
 *   · `undoable` is cleared of what went: an undo that names a deleted agent would fail on the round trip, and
 *     Mod+Z promising work back that no longer exists is worse than not offering it
 * The daemon answers with what it actually deleted, so an agent whose teardown failed stays in the list and is
 * counted out of the report rather than vanishing from a board that never removed it. */
export const purgeArchived = async (): Promise<void> => {
    const aimedAt = archived.value.length;
    const release = claimBusy(archived.value.map((agent) => agent.id));
    try {
        const { removed } = await sandboxJson<{ removed: string[] }>(`/agents/purge`, { method: `POST` });
        const gone = new Set(removed);
        archived.value = archived.value.filter((agent) => !gone.has(agent.id));
        undoable.value = undoable.value.filter((id) => !gone.has(id));
        // A tab reading a deleted agent has nothing left to read: its branch, its worktree and its conversation
        // are gone. Same rule as archiving, which closes them for the far gentler reason.
        useChat().closeTabs(gone);
        /* ...and the ONE thing a close normally keeps goes too (chat/closedDrafts). Setting a message aside is a
         * promise that the chat can be opened again on it, and after this press there is no chat: the entry
         * would come back as a card for a conversation the daemon has deleted, offering to resume a session
         * that no longer exists. This is the fleet's one irreversible press, and it is irreversible here too. */
        for (const id of gone) {
            forgetClosedDraft(id);
        }
        notice.value =
            removed.length < aimedAt ? `Deleted ${removed.length} of ${aimedAt} archived agents, the rest are still in use and stayed.` : undefined;
        say(`${removed.length} archived agent${removed.length === 1 ? `` : `s`} deleted`);
    } catch (error) {
        notice.value = errorMessage(error, `Couldn't delete the archive.`);
    } finally {
        release();
    }
};

// The ONE undo, so the two affordances offering it, a sweep's receipt and Mod+Z, can never come to mean
// different things. A no-op with nothing to put back, which is also what lets the keybinding stay out of the
// way of everything else Mod+Z means (see AgentsView's `when` gate).
export const undoArchive = async (): Promise<void> => {
    if (undoable.value.length === 0) {
        return;
    }
    await restore(undoable.value);
};
