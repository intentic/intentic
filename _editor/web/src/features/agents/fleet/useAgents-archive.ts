import type { AgentSummary } from "@intentic/sandbox-contract";
import { errorMessage } from "@intentic/ui/async";
import { sandboxRef, sandboxScopeGuard } from "@intentic/extension-api";
import { computed, ref } from "vue";
import { forgetClosedDraft } from "../../chat/drafts/closedDrafts";
import { useChat } from "../../chat/run/useChat";
import { commandShortcut } from "../../../shell/commands/useCommands";
import { useNotifications } from "../../../shell/notifications/notifications";
import { type ProcedureOutput, sandboxRpc } from "../../sandbox/client/sandboxRpc";
import { type FleetAgent, lanes } from "./useAgents-fleet";
import { archived, holdPending, moveAhead } from "./useAgents-registry";

// The board's exit: archiving takes an agent off the lanes and reclaims its worktree checkout, keeping the branch,
// transcript and every counter, so it's the routine action (no confirmation, undoable, bulk) while discard stays
// destructive. Takes the chat tab with it, since a card and a tab are one thing under two skins; undo puts the card
// back, not the tab, since reopening it is the user's own action.

// Feedback proportional to consequence: one archive says nothing beyond the card leaving its lane, a bulk sweep gets a
// receipt (since watching one card go is what clearing twelve at once denies you), and a failure gets the persistent
// strip. None of them owns the undo, which is a fact about the store.

// The board's must-read strip for a failed action; no timer, since an error the user never saw surprises them later.
// It names one daemon's agents, like everything below but the pulse.
export const notice = sandboxRef<string | undefined>(() => undefined);

const { say } = useNotifications();

// What the Undo beside a sweep's receipt says on hover; Mod+Z does the same from anywhere on the board.
const undoHint = (): string => {
    const shortcut = commandShortcut(`agents.undoArchive`);
    return shortcut === undefined ? `Put them back on the board` : `Put them back on the board (${shortcut})`;
};

// The ids an undo would put back; consecutive archives merge, since clicking down the Finished lane is one intent and a
// single-press stack would drop the way back to the rest.
export const undoable = sandboxRef<readonly string[]>(() => []);

// Bumped by every archive that moved something; the archive counter pulses on the event, not a flag, since two archives
// owe two pulses.
export const archivedFlash = ref(0);

// A counter per id, not a list: a user archives card by card as fast as they can click, so calls overlap constantly,
// and a shared in-flight set let the first call to finish clear the second one's spinner.
const busyCounts = sandboxRef<ReadonlyMap<string, number>>(() => new Map());
export const busyIds = computed(() => [...busyCounts.value.keys()]);
const claimBusy = (ids: readonly string[]): (() => void) => {
    const claimed = new Map(busyCounts.value);
    for (const id of ids) {
        claimed.set(id, (claimed.get(id) ?? 0) + 1);
    }
    busyCounts.value = claimed;
    // A switch took the counts with the sandbox they counted in; a release after it would decrement a stranger's card.
    const current = sandboxScopeGuard();
    return () => {
        if (!current()) {
            return;
        }
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

// What the daemon refused, said in its own words, on the strip that doesn't expire: releasing a working copy is git
// work and can fail for good (a deleted repository, a locked checkout), and those cards stay on the board.
const refusalNotice = (failed: ProcedureOutput<`agents.archive`>[`failed`]): string => {
    const reason = failed[0]?.reason;
    return failed.length === 1
        ? `Couldn't archive that one: ${reason ?? `its working copy could not be released`}`
        : `Couldn't archive ${failed.length} of them: ${reason ?? `their working copies could not be released`}`;
};

// The cards the daemon moved, filed as the archive's newest and made undoable, taking their tabs with them.
// `restore` is the press's own moveAhead rollback: the rest of what it aimed at comes back.
const fileArchived = (moved: ProcedureOutput<`agents.archive`>[`moved`], rev: number, restore: (keep?: ReadonlySet<string>) => void): void => {
    // A delta, not the roster the daemon happens to hold now, since two archives in flight would otherwise race.
    // Held as a pending move until the daemon publishes a roster at `rev`, or a just-archived card can reappear for
    // a beat.
    const gone = new Set(moved.map((agent) => agent.id));
    holdPending(
        moved.map((agent) => ({ id: agent.id })),
        rev,
    );
    // ...and the rest of what the press aimed at comes back: the daemon's account of which of it was right.
    restore(gone);
    archived.value = [
        // Object.assign, not a spread: `moved` is this call's own freshly-parsed JSON.
        ...moved.map((agent) => Object.assign(agent, { open: false, unread: false, unsent: false })),
        ...archived.value.filter((agent) => !gone.has(agent.id)),
    ];
    // Archiving several cards in a row is one intent, so consecutive archives merge into one undo; the receipt
    // counts the merged set, matching its own button.
    undoable.value = [...moved.map((agent) => agent.id), ...undoable.value.filter((id) => !gone.has(id))];
    archivedFlash.value += 1;
    // The board and strip are two views of one fleet, so cards that leave take their tabs with them, driven off
    // `moved` alone.
    useChat().closeTabs(gone);
};

// What an archive's answer does to the board; a sweep is the one press that reports.
const settleArchive = (
    { moved, failed, rev }: ProcedureOutput<`agents.archive`>,
    restore: (keep?: ReadonlySet<string>) => void,
    sweep: boolean,
): void => {
    if (failed.length > 0) {
        notice.value = refusalNotice(failed);
    }
    if (moved.length === 0) {
        // A press that changed nothing always says so; every card it took on spec goes back, since "nothing moved"
        // is exactly the case the optimistic removal guessed wrong about.
        restore();
        if (failed.length === 0) {
            say(`Nothing to archive, every finished agent is already off the board.`);
        }
        return;
    }
    fileArchived(moved, rev, restore);
    // The archive worked, so a prior failure notice is stale, unless this press is what put it there: a mixed
    // answer keeps the sentence about the card that stayed.
    if (failed.length === 0) {
        notice.value = undefined;
    }
    if (sweep) {
        const count = undoable.value.length;
        say(`${count} agent${count === 1 ? `` : `s`} archived`, undoArchive, undoHint());
    }
};

// Archives the named agents, or with no ids every archivable finished agent (the lane header's "Clear"). The daemon
// answers with what actually moved, since "everything finished" can't be re-derived once the lane is empty.
export const archive = async (ids?: readonly string[]): Promise<void> => {
    // The bulk press borrows the Finished lane's own ids, since that lane is the archivable set by construction.
    const aimed = ids ?? lanes.value.finished.map((agent) => agent.id);
    const release = claimBusy(aimed);
    // A sweep is the archive with no per-card animation to vouch for it, so it's the one that reports.
    const sweep = ids === undefined || ids.length > 1;
    // The cards leave here, not on the answer; see moveAhead for what `restore` puts back.
    const restore = moveAhead(aimed.map((id) => ({ id })));
    // An answer landing after a switch is about cards the board no longer holds; the next sandbox's strip is not its.
    const current = sandboxScopeGuard();
    try {
        const answer = await sandboxRpc.agents.archive(ids === undefined ? {} : { ids: [...ids] });
        if (current()) {
            settleArchive(answer, restore, sweep);
        }
    } catch (error) {
        // The press failed, so the cards it took slide back into their lane, under the strip that says why.
        if (current()) {
            restore();
            notice.value = errorMessage(error, `Couldn't archive that.`);
        }
    } finally {
        release();
    }
};

// The live card an archived entry comes back as: the daemon's summary without the filing date or this browser's own
// fields, which the fleet merge derives afresh.
const onBoard = ({ archivedAt: _filed, open: _open, unread: _unread, unsent: _unsent, draftAt: _draftAt, ...summary }: FleetAgent): AgentSummary =>
    summary as AgentSummary;

// The archive as it stood at the press, less what has left it since, plus what arrived: a restore taken back returns
// each card to its own place rather than to the top.
const withReturned = (before: readonly FleetAgent[], returning: ReadonlySet<string>): FleetAgent[] => {
    const now = new Map(archived.value.map((agent) => [agent.id, agent]));
    const kept = before.flatMap((agent) => (returning.has(agent.id) ? [agent] : (now.get(agent.id) ?? [])));
    const arrived = archived.value.filter((agent) => !before.some((held) => held.id === agent.id));
    return [...arrived, ...kept];
};

// Puts agents back on the board on the press, the inverse an archive's undo runs, and back in the archive if the
// daemon doesn't move them; the checkout isn't rebuilt, so a hundred cost what one does.
export const restore = async (ids: readonly string[]): Promise<void> => {
    const release = claimBusy(ids);
    const before = archived.value;
    const leaving = before.filter((agent) => ids.includes(agent.id));
    const unput = moveAhead(leaving.map((agent) => ({ id: agent.id, present: onBoard(agent) })));
    archived.value = before.filter((agent) => !ids.includes(agent.id));
    const current = sandboxScopeGuard();
    try {
        const { moved, rev } = await sandboxRpc.agents.unarchive({ ids: [...ids] });
        if (!current()) {
            return;
        }
        // The same delta, in the other direction, held the same way, so a snapshot in flight can't take the restored
        // card straight back off.
        const back = new Set(moved.map((agent) => agent.id));
        holdPending(
            moved.map((agent) => ({ id: agent.id, present: agent })),
            rev,
        );
        // ...and whatever the press drew that the daemon didn't move goes back to the archive it came from.
        unput(back);
        if (back.size < leaving.length) {
            archived.value = withReturned(before, new Set(leaving.filter((agent) => !back.has(agent.id)).map((agent) => agent.id)));
        }
        // What's back on the board is no longer anyone's to undo, including a card-by-card restore from the archive
        // view.
        undoable.value = undoable.value.filter((id) => !back.has(id));
        say(`${back.size} agent${back.size === 1 ? `` : `s`} back on the board`);
        notice.value = undefined;
    } catch (error) {
        if (!current()) {
            return;
        }
        unput();
        archived.value = withReturned(before, new Set(leaving.map((agent) => agent.id)));
        notice.value = errorMessage(error, `Couldn't restore that.`);
    } finally {
        release();
    }
};

// Empties the archive, the fleet's one irreversible action, the only way to permanently remove an agent since every
// other exit keeps the branch. Confirms first, always reports even for one agent with no Undo on the receipt, and
// clears any pending undo naming a now-deleted agent.
export const purgeArchived = async (): Promise<void> => {
    const aimedAt = archived.value.length;
    const release = claimBusy(archived.value.map((agent) => agent.id));
    const current = sandboxScopeGuard();
    try {
        const { removed } = await sandboxRpc.agents.purge();
        if (!current()) {
            return;
        }
        const gone = new Set(removed);
        archived.value = archived.value.filter((agent) => !gone.has(agent.id));
        undoable.value = undoable.value.filter((id) => !gone.has(id));
        // A tab reading a deleted agent has nothing left to read: its branch, worktree and conversation are gone.
        useChat().closeTabs(gone);
        // ...and the one thing a close normally keeps goes too: setting a message aside promises the chat can reopen,
        // but after this press there is no chat left to reopen.
        for (const id of gone) {
            forgetClosedDraft(id);
        }
        notice.value =
            removed.length < aimedAt ? `Deleted ${removed.length} of ${aimedAt} archived agents, the rest are still in use and stayed.` : undefined;
        say(`${removed.length} archived agent${removed.length === 1 ? `` : `s`} deleted`);
    } catch (error) {
        if (!current()) {
            return;
        }
        notice.value = errorMessage(error, `Couldn't delete the archive.`);
    } finally {
        release();
    }
};

// The one undo, so a sweep's receipt and Mod+Z can never mean different things; a no-op with nothing to put back.
export const undoArchive = async (): Promise<void> => {
    if (undoable.value.length === 0) {
        return;
    }
    await restore(undoable.value);
};
