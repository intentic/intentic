import { t } from "@intentic/ui/i18n";
import { onScopeDispose, ref, type Ref, watch } from "vue";
import { useOperation } from "../../../../workbench/operations/operations";
import type { BoardView, ViewEvent } from "./boardView";

// The archive's door and what the board says about it. Archiving is lossless, so it asks nothing and says little: the
// counter pulses and a screen reader hears it. Emptying the archive is the one irreversible press, so it asks first.

export interface DoorHost {
    readonly view: Readonly<Ref<BoardView>>;
    readonly move: (event: ViewEvent) => void;
    // The fleet store's archive half (useAgents); `archivedFlash` is bumped by every archive that moved something.
    readonly agents: {
        readonly archived: Readonly<Ref<readonly unknown[]>>;
        readonly loadArchived: () => Promise<void>;
        readonly purgeArchived: () => Promise<void>;
        readonly archivedFlash: Readonly<Ref<number>>;
        readonly undoable: Readonly<Ref<readonly string[]>>;
    };
}

// Where the ledger keeps the purge: the sandbox's archive, not this board's.
export const PURGE_ARCHIVE = `agents/archive/purge`;

// Long enough to catch the eye following a card out of its lane, short enough to read as a move, not a new state (ms).
const PULSE_MS = 1_100;

export const useArchiveDoor = (host: DoorHost) => {
    const { agents } = host;
    // What the board tells a screen reader, since neither visual report (the counter's pulse, the receipt) says it alone.
    const announcement = ref(``);
    // The confirm dialog is open. Bulk only, never per card, where it would sit a pixel from Restore on the same hover row.
    const pendingPurge = ref(false);
    // Kept in the operations ledger, not this board: a board left and opened again while the daemon deletes still
    // holds Delete all. What it went on to say (its receipt, or a refusal on the notice strip) is purgeArchived's own.
    const purge = useOperation(PURGE_ARCHIVE);
    const purging = purge.busy;
    const pulsing = ref(false);
    let pulseTimer: ReturnType<typeof setTimeout> | undefined;

    // Every opening re-reads the pile.
    const toggleArchive = async (): Promise<void> => {
        host.move({ kind: `door` });
        if (host.view.value.archive) {
            await agents.loadArchived();
        }
    };
    const confirmPurge = async (): Promise<void> => {
        pendingPurge.value = false;
        const aimedAt = agents.archived.value.length;
        const outcome = await purge.run({
            what: t(`agents.archiveDoor.deleting`),
            failed: t(`agents.useAgentsArchive.couldntDeleteArchive`),
            quiet: true,
            task: () => agents.purgeArchived(),
        });
        if (outcome?.state !== `done`) {
            return;
        }
        host.move({ kind: `purged` });
        // The one report here nothing on screen can re-derive, since what it is about is gone.
        const deleted = aimedAt - agents.archived.value.length;
        announcement.value = t(`agents.archiveDoor.deleted`, { count: deleted }, deleted);
    };
    // One archive, one reaction: the counter's pulse and the screen reader's line are the same event said twice.
    watch(agents.archivedFlash, () => {
        pulsing.value = true;
        clearTimeout(pulseTimer);
        pulseTimer = setTimeout(() => (pulsing.value = false), PULSE_MS);
        const archived = agents.undoable.value.length;
        announcement.value = t(`agents.useAgentsArchive.archivedCount`, { count: archived }, archived);
    });
    onScopeDispose(() => clearTimeout(pulseTimer));
    return { announcement, pendingPurge, purging, pulsing, toggleArchive, confirmPurge };
};
