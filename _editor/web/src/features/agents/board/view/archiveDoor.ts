import { onScopeDispose, ref, type Ref, watch } from "vue";
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

// Long enough to catch the eye following a card out of its lane, short enough to read as a move, not a new state (ms).
const PULSE_MS = 1_100;

export const useArchiveDoor = (host: DoorHost) => {
    const { agents } = host;
    // What the board tells a screen reader, since neither visual report (the counter's pulse, the receipt) says it alone.
    const announcement = ref(``);
    // The confirm dialog is open. Bulk only, never per card, where it would sit a pixel from Restore on the same hover row.
    const pendingPurge = ref(false);
    const purging = ref(false);
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
        purging.value = true;
        const aimedAt = agents.archived.value.length;
        try {
            await agents.purgeArchived();
            host.move({ kind: `purged` });
            // The one report here nothing on screen can re-derive, since what it is about is gone.
            announcement.value = `${aimedAt - agents.archived.value.length} archived agents deleted`;
        } finally {
            purging.value = false;
        }
    };
    // One archive, one reaction: the counter's pulse and the screen reader's line are the same event said twice.
    watch(agents.archivedFlash, () => {
        pulsing.value = true;
        clearTimeout(pulseTimer);
        pulseTimer = setTimeout(() => (pulsing.value = false), PULSE_MS);
        announcement.value = `${agents.undoable.value.length} agent${agents.undoable.value.length === 1 ? `` : `s`} archived`;
    });
    onScopeDispose(() => clearTimeout(pulseTimer));
    return { announcement, pendingPurge, purging, pulsing, toggleArchive, confirmPurge };
};
