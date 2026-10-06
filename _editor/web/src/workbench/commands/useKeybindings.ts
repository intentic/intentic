import { onMounted, onUnmounted } from "vue";
import { boundCommand, executeCommand } from "./useCommands";
import { isApplePlatform } from "./keybindings";

// Global keybinding dispatcher: one window keydown listener that turns a keystroke into a command invocation. The
// first registered command whose chord matches and whose `when` gate is open wins; its default action is
// suppressed. Installed on mount, removed on unmount, by whichever surface owns this window.
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
        // A throwing command is its owner's bug: contained to the console, never breaks key handling.
        void Promise.resolve(executeCommand(bound.command)).catch((caught: unknown) => console.error(`command ${bound.command} failed`, caught));
    };

    onMounted(() => window.addEventListener(`keydown`, onKey));

    onUnmounted(() => window.removeEventListener(`keydown`, onKey));
}
