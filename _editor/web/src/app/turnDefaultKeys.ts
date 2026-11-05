import { accountKey } from "@intentic/ui/storage";

// The storage keys of what a new conversation starts on (models/conversations/run/turnDefaults.ts). A leaf importing only
// the storage kit, in the bottom layer, because self-heal (app/selfHeal.ts) reads it at the first line of boot, before any
// module that would pull in the catalogs.
//
// The account's, each in its drawer (@intentic/ui/storage): the models a person picks name what their account runs, and
// a second account on this browser opened every new chat on the first one's pick. Declared here, at boot, so the drawer
// holds them before the composer's module loads.
//
// Self-heal keeps exactly these across its wipe. Each is a short string that its own `read` validates, so none of them
// can be the poisoned blob a wipe is for, and losing them costs more than a theme: an emptied model map reads as the
// seed catalog's head before the live catalog answers, and every new chat then quietly opened on an older model.

export const TURN_DEFAULT_KEYS = {
    provider: accountKey(`ui-chat-provider`),
    harnesses: accountKey(`ui-chat-harness`),
    models: accountKey(`ui-chat-models`),
    effort: accountKey(`ui-chat-effort`),
    thinking: accountKey(`ui-chat-thinking`),
    auto: accountKey(`ui-chat-auto`),
} as const;
