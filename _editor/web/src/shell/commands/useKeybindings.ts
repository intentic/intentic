import { onMounted, onUnmounted } from "vue";
import { boundCommand, executeCommand } from "./useCommands";
import { isApplePlatform } from "./keybindings";

/* The shell's global keybinding dispatcher: ONE window keydown listener that turns a keystroke into a command
 * invocation. Registered commands are the single source of truth, a command's own `keybinding` is its shortcut,
 * so there is no second binding table to drift (the same "the command IS the binding" bet the shell already makes).
 * The first command whose chord matches (and whose `when` gate, if any, is open) wins; its default browser action
 * is suppressed and it runs by id. Because builtins and extension-contributed commands share the registry, an
 * extension gets working shortcuts for free the day it declares one. Installed on mount / removed on unmount by
 * whichever surface owns this window, the desktop shell, or a floating panel's own page, which has no shell but
 * still wants F9 to dock the panel it is holding.
 *
 * ONE listener, on this window, and that is now the whole story. It used to mirror itself onto every pop-out
 * window's document, because a floating panel's keystrokes dispatch in ITS window and the panel was drawn from
 * this realm. A floating panel runs its own copy of the app now (composables/floating.ts), so its keystrokes
 * reach its own dispatcher and there is nothing to mirror. */
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

    onUnmounted(() => window.removeEventListener(`keydown`, onKey));
}
