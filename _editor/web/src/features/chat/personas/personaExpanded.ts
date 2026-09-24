import { definePreference } from "@intentic/ui/preference";
import type { Ref } from "vue";

// Which groups of the rail's Personas cut are open, by persona id (ANYONE for the chats wearing none). An account
// preference like the cut itself, so a popped-out window and a reload open on the same groups.

export const ANYONE = `*`;

const expanded: Ref<ReadonlySet<string>> = definePreference<ReadonlySet<string>>({
    key: `ui-chat-persona-expanded`,
    read: (raw) => {
        try {
            const parsed: unknown = JSON.parse(raw ?? `[]`);
            return new Set(Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === `string`) : []);
        } catch {
            return new Set();
        }
    },
    write: (value) => JSON.stringify([...value]),
});

export const usePersonaExpanded = () => ({
    isExpanded: (key: string): boolean => expanded.value.has(key),
    toggle: (key: string): void => {
        const next = new Set(expanded.value);
        if (!next.delete(key)) {
            next.add(key);
        }
        expanded.value = next;
    },
    open: (key: string): void => {
        if (!expanded.value.has(key)) {
            expanded.value = new Set(expanded.value).add(key);
        }
    },
});
