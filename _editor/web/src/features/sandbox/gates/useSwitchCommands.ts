import type { Disposable } from "@intentic/extension-api";
import type { SandboxSummary } from "@intentic/api-contract";
import { useT } from "@intentic/ui/i18n";
import { onMounted, onUnmounted, type Ref, watch, type WatchStopHandle } from "vue";
import { SANDBOX } from "../../../workbench/commands/categories";
import { commandShortcut, registerCommand } from "../../../workbench/commands/useCommands";

// THE SWITCHER'S CHORDS (SandboxSwitcher.vue): Alt+1…9 for the sandboxes in the order its list draws them, and Alt+0 for
// this computer inside the desktop app. Registered while the switcher is mounted, which is the whole session.

// Alt+1…9 picks the Nth switchable sandbox; a digit past the end does nothing rather than clamping.
const SWITCH_SLOTS = 9;
/** Reads the chord from the registry rather than a literal "Alt+N", so a remap or unbind shows correctly. */
export const slotChord = (at: number): string | undefined => (at < SWITCH_SLOTS ? commandShortcut(`sandbox.switch${at + 1}`) : undefined);

/** `switchable` is the switcher's list in popover order (unfinished setups are not in it); `thisComputer` is undefined
 *  outside the desktop app, the one place this computer is a place. */
export const useSwitchCommands = (
    switchable: Readonly<Ref<readonly SandboxSummary[]>>,
    pick: (option: SandboxSummary) => void,
    thisComputer: (() => void) | undefined,
): void => {
    const t = useT();
    let disposables: readonly Disposable[] = [];

    const release = (): void => {
        for (const disposable of disposables) {
            disposable.dispose();
        }
        disposables = [];
    };

    // One command per box that exists, not per slot: an empty slot's command would be a palette row with nowhere to go.
    // Re-registered as the roster changes, so a box added in another window is a chord here without a reload.
    const syncSwitchCommands = (options: readonly SandboxSummary[]): void => {
        release();
        disposables = options.slice(0, SWITCH_SLOTS).map((_option, at) =>
            registerCommand({
                owner: `builtin`,
                command: `sandbox.switch${at + 1}`,
                // Getter, so the row names the box this chord lands on even as the roster reorders under it.
                get title(): string {
                    const option = switchable.value[at];
                    return option === undefined ? t(`sandbox.sandboxSwitcher.switchToSlot`, { slot: at + 1 }) : t(`sandbox.sandboxSwitcher.switchTo`, { name: option.name });
                },
                category: SANDBOX,
                icon: `server`,
                keybinding: `Alt+${at + 1}`,
                handler: (): void => {
                    // The Nth switchable sandbox, in popover order; unfinished setups are excluded from it.
                    const option = switchable.value[at];
                    if (option !== undefined) {
                        pick(option);
                    }
                },
            }),
        );
    };

    // Held rather than left to the component's scope, so the watcher stops in the same breath the commands are released.
    let stopSync: WatchStopHandle | undefined;

    // ALT+0 IS THIS COMPUTER, the place listed first, beside Alt+1…9 for the sandboxes under it; a local window binds the
    // same digits to the same sandboxes (local/localKeys.ts).
    let thisComputerCommand: Disposable | undefined;

    onMounted(() => {
        stopSync = watch(switchable, syncSwitchCommands, { immediate: true });
        if (thisComputer !== undefined) {
            thisComputerCommand = registerCommand({
                owner: `builtin`,
                command: `sandbox.thisComputer`,
                // Getter, so the palette row follows a language switch.
                get title(): string {
                    return t(`sandbox.sandboxSwitcher.switchToThisComputer`);
                },
                category: SANDBOX,
                icon: `desktop`,
                keybinding: `Alt+0`,
                handler: thisComputer,
            });
        }
    });

    onUnmounted(() => {
        stopSync?.();
        stopSync = undefined;
        release();
        thisComputerCommand?.dispose();
        thisComputerCommand = undefined;
    });
};
