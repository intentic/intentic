import { watch } from "vue";
import { reloadOnHotUpdate } from "../../../app/hotReload";
import type { Conversation } from "../session/conversation";
import type { SharedPicks } from "../session/selectionReducer";
import { conversations } from "../tabs/useChat-tabs";
import { onChatNote, postChatNote } from "./chatChannel";

/* ONE CHAT'S PICKS, THE SAME IN EVERY WINDOW. Each window holds its own copy of every chat it has open, the windows not
   drawing the chat included (summon.ts keeps their strip current), and a summons hands a copy the picks of the moment it
   was sent, never the ones made after. A copy left on a new chat's seed (Codex) while the person moved it to Claude in
   the window drawing it read the record's Claude session against Codex, drew "Switched to Codex" over a chat that never
   left Claude, and would have sent there (2026-10-28). So a pick made in one window (ECHOED_PICKS) goes to every other
   window holding the chat, which writes it outright, as a restored tab's picks are written. */

// The wire's picks: JSON drops an undefined key, and a key left out would keep the receiver's own value (an account of
// the provider the sender just left), so an unset pick travels as null.
export type WirePicks = {
    readonly [K in keyof SharedPicks]-?: undefined extends SharedPicks[K] ? Exclude<SharedPicks[K], undefined> | null : SharedPicks[K];
};

export const wirePicks = (picks: SharedPicks): WirePicks => ({
    provider: picks.provider,
    harness: picks.harness,
    account: picks.account ?? null,
    model: picks.model,
    movedFrom: picks.movedFrom ?? null,
    displacedModel: picks.displacedModel ?? null,
    thinking: picks.thinking,
    fast: picks.fast,
    auto: picks.auto,
    effortPick: picks.effortPick,
});

export const receivedPicks = (picks: WirePicks): SharedPicks => ({
    provider: picks.provider,
    harness: picks.harness,
    account: picks.account ?? undefined,
    model: picks.model,
    movedFrom: picks.movedFrom ?? undefined,
    displacedModel: picks.displacedModel ?? undefined,
    thinking: picks.thinking,
    fast: picks.fast,
    auto: picks.auto,
    effortPick: picks.effortPick,
});

// The same chat is the same id in the same sandbox: an id repeats across boxes (a person's home is named alike in each).
const holds = (conversation: Conversation, note: { readonly conversationId: string; readonly box?: string }): boolean =>
    conversation.conversationId === note.conversationId && conversation.placement.value === note.box;

// The last picks this window told the others, per chat, so a list change re-tells nobody.
const told = new WeakMap<Conversation, SharedPicks>();

// allow(module-state): the one install per window; a second would tell every pick twice and write every echo twice.
let installed = false;

/** Keeps every chat this window holds in step with the picks made for it in other windows, and tells them its own. */
export const echoPicksAcrossWindows = (): void => {
    if (installed) {
        return;
    }
    installed = true;
    onChatNote(`picks`, (note) => {
        const picks = receivedPicks(note.picks);
        for (const conversation of conversations.value) {
            if (holds(conversation, note)) {
                conversation.selection.apply({ kind: `set`, picks });
            }
        }
    });
    watch(
        () => conversations.value.map((conversation) => [conversation, conversation.selection.echoed.value] as const),
        (open) => {
            for (const [conversation, picks] of open) {
                if (picks === undefined || told.get(conversation) === picks) {
                    continue;
                }
                told.set(conversation, picks);
                const box = conversation.placement.value;
                const note = { kind: `picks`, conversationId: conversation.conversationId, picks: wirePicks(picks) } as const;
                postChatNote(box === undefined ? note : { ...note, box });
            }
        },
        { flush: `sync` },
    );
};

// One reader and one watch per window; a hot-reloaded rerun would tell every pick twice.
reloadOnHotUpdate(import.meta);
