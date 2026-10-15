// The storage keys of what a new conversation starts on (features/chat/run/turnDefaults.ts). A leaf with no imports, in
// the bottom layer, because self-heal (app/selfHeal.ts) reads it at the first line of boot, before any module that would
// pull in the catalogs.
//
// Self-heal keeps exactly these across its wipe. Each is a short string that its own `read` validates, so none of them
// can be the poisoned blob a wipe is for, and losing them costs more than a theme: an emptied model map reads as the
// seed catalog's head before the live catalog answers, and every new chat then quietly opened on an older model.

export const TURN_DEFAULT_KEYS = {
    provider: `ui-chat-provider`,
    harnesses: `ui-chat-harness`,
    models: `ui-chat-models`,
    effort: `ui-chat-effort`,
    thinking: `ui-chat-thinking`,
    auto: `ui-chat-auto`,
} as const;
