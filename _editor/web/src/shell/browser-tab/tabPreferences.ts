import type { Ref } from "vue";
import { definePreference } from "@intentic/ui/preference";

// The reader's say over what the browser tab does, per browser like every display preference: a laptop that rings
// and a desktop that does not is a choice somebody makes on purpose. Only the default is ever left unwritten.

// On unless turned off: a count in a tab's title is what every mail and chat app does, and asks nothing of anyone.
export const tabStatus: Ref<boolean> = definePreference<boolean>({
    key: `ui-tab-status`,
    read: (raw) => raw !== `off`,
    write: (value) => (value ? null : `off`),
});

// Off unless turned on: a page that makes noise nobody asked for is the fastest way to be muted for good.
export const chimeAsks: Ref<boolean> = definePreference<boolean>({
    key: `ui-chime-asks`,
    read: (raw) => raw === `on`,
    write: (value) => (value ? `on` : null),
});

export const chimeFinished: Ref<boolean> = definePreference<boolean>({
    key: `ui-chime-finished`,
    read: (raw) => raw === `on`,
    write: (value) => (value ? `on` : null),
});
