import { onMounted, onUnmounted, watch } from "vue";
import { commands, executeCommand } from "./useCommands";
import { effectiveKeybinding } from "./useKeymap";
import { isApplePlatform, matchesChord } from "./keybindings";
import { useChatPopout } from "../chat/useChatPopout";
import { useTerminalPopout } from "../terminal/useTerminalPopout";

/* The shell's global keybinding dispatcher: ONE window keydown listener that turns a keystroke into a command
 * invocation. Registered commands are the single source of truth — a command's own `keybinding` is its shortcut,
 * so there is no second binding table to drift (the same "the command IS the binding" bet the shell already makes).
 * The first command whose chord matches wins; its default browser action is suppressed and it runs by id. Because
 * builtins and extension-contributed commands share the registry, an extension gets working shortcuts for free the
 * day it declares one. Installed on mount / removed on unmount by the desktop shell, mirroring the listener it
 * replaces, so a mobile↔desktop crossover leaves no orphaned handler. */
export function useKeybindings(): void {
    const isMac = isApplePlatform();

    const onKey = (event: KeyboardEvent): void => {
        // Ignore lone modifier presses cheaply before scanning the registry.
        if (event.key === `Control` || event.key === `Shift` || event.key === `Alt` || event.key === `Meta`) {
            return;
        }
        // Match against the EFFECTIVE chord (user override ?? declared default), so a remap takes effect live and an
        // unbound command stops firing — the keymap is the source of truth, the declared value only its default.
        const bound = commands.value.find((entry) => {
            const chord = effectiveKeybinding(entry.command, entry.keybinding);
            return chord !== undefined && matchesChord(chord, event, isMac);
        });
        if (bound === undefined) {
            return;
        }
        event.preventDefault();
        // A throwing command is its owner's bug — contain it to the console, never break key handling.
        void Promise.resolve(executeCommand(bound.command)).catch((caught: unknown) => console.error(`command ${bound.command} failed`, caught));
    };

    onMounted(() => window.addEventListener(`keydown`, onKey));

    // A popped-out panel's keystrokes dispatch in ITS window, never this one — mirror the listener onto each
    // pip window while it exists, so shortcuts keep working inside the floating chat/terminal. The pip document
    // dies with its window, so only a still-open body needs explicit removal on unmount.
    const popouts = [useChatPopout(), useTerminalPopout()];
    for (const popout of popouts) {
        watch(popout.pipBody, (body, previous) => {
            previous?.ownerDocument.defaultView?.removeEventListener(`keydown`, onKey);
            body?.ownerDocument.defaultView?.addEventListener(`keydown`, onKey);
        });
    }

    onUnmounted(() => {
        window.removeEventListener(`keydown`, onKey);
        for (const popout of popouts) {
            popout.pipBody.value?.ownerDocument.defaultView?.removeEventListener(`keydown`, onKey);
        }
    });
}
