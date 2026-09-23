import type { Disposable } from "@intentic/extension-api";
import { t } from "@intentic/ui/i18n";
import { computed, onMounted, onUnmounted, type Ref } from "vue";
import { AGENTS } from "../../../../shell/commands/categories";
import { publishContextKey } from "../../../../shell/commands/contextKeys";
import { registerCommand } from "../../../../shell/commands/useCommands";

// What the board does on arriving and holds while it is on screen: it reads the roster and the archive, and claims
// Mod+Z and the filter's accelerator, which it hands back the moment it leaves.

export interface CommandsHost {
    // The fleet store's reads, and the undo Mod+Z runs while there is something to undo.
    readonly agents: {
        readonly refresh: () => Promise<void>;
        readonly loadArchived: () => Promise<void>;
        readonly undoArchive: () => Promise<void>;
        readonly undoable: Readonly<Ref<readonly string[]>>;
    };
    // The filter's field, which its accelerator focuses and selects.
    readonly filterField: Readonly<Ref<{ readonly focus: (select?: boolean) => void } | undefined>>;
}

// Called from the board's setup: it registers on mount and disposes on unmount.
export const useBoardCommands = (host: CommandsHost): void => {
    const { agents } = host;
    let claims: readonly Disposable[] = [];
    onMounted(() => {
        void agents.refresh();
        // Worth the request at mount: without a count, Finished offers an archive nobody has reason to believe holds anything.
        void agents.loadArchived();
        claims = [
            // Published only while the board is mounted, so Mod+Z hands itself back the moment the fleet leaves the screen.
            publishContextKey(
                `agentsUndoable`,
                computed(() => agents.undoable.value.length > 0),
            ),
            // An archive says nothing, so it undoes by reflex; `when` hands the chord back with nothing to undo or in a field.
            registerCommand({
                owner: `builtin`,
                command: `agents.undoArchive`,
                title: t(`agents.agentsView.undoArchive`),
                category: AGENTS,
                icon: `history`,
                keybinding: `Mod+Z`,
                when: `agentsUndoable && !editableTarget`,
                handler: agents.undoArchive,
            }),
            // Unbound: Mod+F is the browser's, and this registry spans every window, the floating chat's included.
            registerCommand({
                owner: `builtin`,
                command: `agents.filter`,
                title: t(`agents.agentsView.filter`),
                category: AGENTS,
                icon: `search`,
                // Focus and select, so a chord typed over a stale query starts fresh instead of needing it cleared first.
                handler: () => host.filterField.value?.focus(true),
            }),
        ];
    });
    onUnmounted(() => {
        for (const disposable of claims) {
            disposable.dispose();
        }
        claims = [];
    });
};
