import { definePreference } from "@intentic/ui/preference";
import type { Ref } from "vue";

// The commands this reader ran last, most recent first, so an empty palette opens on the handful someone actually uses
// instead of the alphabet. An account preference like the keymap (per machine, shared with popped-out windows), and
// chrome rather than data: an unreadable value is simply no history.

const STORAGE_KEY = `ui-command-recents`;

/** Long enough to cover a working habit, short enough that the block stays readable above the full list. */
const KEEP = 7;

const read = (raw: string | null): readonly string[] => {
    if (raw === null) {
        return [];
    }
    try {
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === `string`).slice(0, KEEP) : [];
    } catch {
        return [];
    }
};

export const recentCommandIds: Ref<readonly string[]> = definePreference<readonly string[]>({
    key: STORAGE_KEY,
    read,
    write: (value) => JSON.stringify(value),
});

/** Records a run: the id moves to the front, never appearing twice, and the oldest falls off the end. */
export const rememberCommand = (command: string): void => {
    recentCommandIds.value = [command, ...recentCommandIds.value.filter((entry) => entry !== command)].slice(0, KEEP);
};
