import { onMounted, onUnmounted, watch } from "vue";
import { boundCommand, executeCommand } from "./useCommands";
import { isApplePlatform } from "./keybindings";
import { useChatPopout } from "../chat/useChatPopout";
import { useTerminalPopout } from "../terminal/useTerminalPopout";

/* The shell's global keybinding dispatcher: ONE window keydown listener that turns a keystroke into a command
 * invocation. Registered commands are the single source of truth, a command's own `keybinding` is its shortcut,
 * so there is no second binding table to drift (the same "the command IS the binding" bet the shell already makes).
 * The first command whose chord matches (and whose `when` gate, if any, is open) wins; its default browser action
 * is suppressed and it runs by id. Because builtins and extension-contributed commands share the registry, an
 * extension gets working shortcuts for free the day it declares one. Installed on mount / removed on unmount by
 * the desktop shell, mirroring the listener it replaces, so a mobile↔desktop crossover leaves no orphaned handler. */
export function useKeybindings(): void {
    const isMac = isApplePlatform();

    const onKey = (event: KeyboardEvent): void => {
        // Ignore lone modifier presses cheaply before scanning the registry.
        if (event.key === `Control` || event.key === `Shift` || event.key === `Alt` || event.key === `Meta`) {
            return;
        }
        const bound = boundCommand(event, isMac);
        if (bound === undefined) {
            return;
        }
        event.preventDefault();
        // A throwing command is its owner's bug, contain it to the console, never break key handling.
        void Promise.resolve(executeCommand(bound.command)).catch((caught: unknown) => console.error(`command ${bound.command} failed`, caught));
    };

    onMounted(() => window.addEventListener(`keydown`, onKey));

    /* A popped-out panel's keystrokes dispatch in ITS window, never this one, mirror the listener onto each
     * pop-out window while it exists, so shortcuts keep working inside the floating chat/terminal. That document
     * dies with its window, so only a still-open body needs explicit removal on unmount.
     *
     * Immediate, because a floating window now outlives this dispatcher: the panels are mounted above the router
     * (shell/dockSlots.ts) and only the SHELL comes and goes, so on a step out to /setup and back there is a
     * window already open that no `body` change will ever announce again. */
    const popouts = [useChatPopout(), useTerminalPopout()];
    for (const popout of popouts) {
        watch(
            popout.body,
            (body, previous) => {
                previous?.ownerDocument.defaultView?.removeEventListener(`keydown`, onKey);
                body?.ownerDocument.defaultView?.addEventListener(`keydown`, onKey);
            },
            { immediate: true },
        );
    }

    onUnmounted(() => {
        window.removeEventListener(`keydown`, onKey);
        for (const popout of popouts) {
            popout.body.value?.ownerDocument.defaultView?.removeEventListener(`keydown`, onKey);
        }
    });
}
