import { type Persona, type PersonaRoute, PersonaRouteSchema, mentionPaths, personaModels } from "@intentic/sandbox-contract";
import { computed, type ComputedRef, type Ref, ref, watch } from "vue";
import { jsonBody } from "../../sandbox/client/jsonBody";
import { sandboxJson } from "../../sandbox/client/sandboxClient";
import { usePersonas } from "../../sandbox/personas/usePersonas";
import { useSandboxSettings } from "../../sandbox/overview/useSandboxSettings";
import type { Conversation } from "../session/conversation";
import { roleSources } from "../accounts/roleModel";

/* WHICH PERSONA A NEW CHAT BELONGS TO, asked of the daemon from the composer, before the first turn.
 *
 * THE DAEMON READS, THE COMPOSER APPLIES. The reading is a small model call (the daemon's persona-router.ts, on
 * the `persona-router` list), so it is asked ONCE per settled draft rather than per keystroke, and only while
 * every gate below holds: routing is on (settings.personaRouting), the chat has no turns yet, nobody has pinned
 * a persona by hand, the chat runs in this sandbox (a persona is one daemon's card), and there are enough words
 * to read. The answer is a card id or none, with a reason; what the composer does with it is the mode's business:
 *
 *   suggest — the answer is a chip; pressing it puts the card on. Nothing happens at send.
 *   auto    — the answer is applied when the message is sent, unless the chip was pressed first, which
 *             declines it for this chat (`held`). A send that arrives before the answer waits for it, briefly:
 *             a persona decides which repositories the conversation's tree holds, and that can only be decided
 *             on the opening turn (the daemon's conversation-context.ts), so a late answer is no answer.
 *
 * PUTTING THE CARD ON MEANS ITS MODEL TOO. A card with a ladder (Persona.models) names what its sessions run on;
 * the composer moves the pill to the ladder's head as the card goes on, whichever door it came through, because
 * the card is the static context and the model that reads it is part of that context (Conversation.wearModel).
 *
 * STATE IS PER CONVERSATION, kept beside it rather than on it: the chat pane swaps its conversation in place,
 * and an answer for one chat must never be shown over another. It is not persisted with the tab: a reload of an
 * unsent draft asks again, which costs one small call and can never apply a stale reading. */

// How long typing has to pause before the draft counts as settled and is read. Long enough that a sentence is
// not read three times while it is written, short enough that the chip is there by the time the hand moves to
// the send button.
export const SETTLE_MS = 1_200;
// How long a send in `auto` waits for a reading still in flight before going out as it would have anyway.
export const SEND_WAIT_MS = 4_000;
// Fewer characters than this is not a message anyone can route: "fix it" belongs to nobody.
const MIN_CHARS = 12;

interface RouteState {
    // The daemon's latest answer, with the text it answered for. Kept while the draft grows: a stale answer is
    // still the best reading there is until the next one lands, and a chip that vanished on every keystroke
    // would be unreadable.
    readonly answer: Ref<{ readonly text: string; readonly route: PersonaRoute } | undefined>;
    // The user declined the route for this chat: `auto`'s press, or a pick made by hand at the persona pill.
    // Nothing is asked, shown or applied again.
    readonly held: Ref<boolean>;
    inflight: { readonly text: string; readonly promise: Promise<PersonaRoute | undefined> } | undefined;
    timer: ReturnType<typeof setTimeout> | undefined;
}

const states = new WeakMap<Conversation, RouteState>();
const stateOf = (chat: Conversation): RouteState => {
    let state = states.get(chat);
    if (state === undefined) {
        state = { answer: ref(undefined), held: ref(false), inflight: undefined, timer: undefined };
        states.set(chat, state);
    }
    return state;
};

export type PersonaRoutePreview =
    // `suggest`: the answer, offered; a press puts the card on. `route`: `auto`'s answer, about to be applied at
    // send; a press declines it. `held`: that press has been taken; the same press lifts it.
    | { readonly kind: `suggest` | `route`; readonly persona: Persona; readonly reason: string }
    | { readonly kind: `held`; readonly persona: Persona; readonly reason: string };

export interface PersonaRouting {
    readonly preview: ComputedRef<PersonaRoutePreview | undefined>;
    // The chip's one press, whichever state it is in.
    readonly press: () => void;
    // A persona picked at the pill, by hand, including "Anyone": routing has been overruled for this chat.
    readonly byHand: () => void;
    /* What a send has to wait for, or undefined for "nothing, send now": only an `auto` chat that is still
     * eligible waits, and only as long as SEND_WAIT_MS. Resolves after the card has been put on (or not). */
    readonly beforeSend: (text: string) => Promise<void> | undefined;
}

// The paths the message names, the second fact the daemon's router can match a card against: uploads first,
// then @-mentions, without repeats. No folder: a chat opened from the composer has none to speak of.
const pathsOf = (chat: Conversation, text: string): string[] => {
    const uploaded = chat.attachments.value.map((file) => file.path);
    return [...uploaded, ...mentionPaths(text).filter((path) => !uploaded.includes(path))];
};

export const usePersonaRoute = (conversation: () => Conversation, draft: () => string): PersonaRouting => {
    const { settings } = useSandboxSettings();
    const { personas } = usePersonas();
    // Off until settings have loaded: a call made on a guess about the mode is a call the owner may have
    // switched off.
    const mode = computed(() => settings.value?.personaRouting ?? `off`);

    // The chat is one a reading could still be shown for: routing on, this sandbox, no turns, nobody pinned.
    const open = (chat: Conversation): boolean =>
        mode.value !== `off` && chat.box.value === undefined && chat.messages.value.length === 0 && chat.actsAs.value === undefined;
    // …and one a reading may still be ASKED for and applied to: open, and not declined.
    const eligible = (chat: Conversation): boolean => open(chat) && !stateOf(chat).held.value;

    /* ONE READING PER TEXT. The same words are never asked twice, and an ask already in flight for them is
     * joined rather than repeated. A failed call reads as `none`: the chat opens as it would have, and the
     * chip says nothing rather than something wrong. */
    const ask = (chat: Conversation, text: string): Promise<PersonaRoute | undefined> => {
        const state = stateOf(chat);
        if (state.answer.value?.text === text) {
            return Promise.resolve(state.answer.value.route);
        }
        if (state.inflight?.text === text) {
            return state.inflight.promise;
        }
        const promise = sandboxJson(`/personas/route`, jsonBody(`POST`, { prompt: text, paths: pathsOf(chat, text) }))
            .then((raw) => PersonaRouteSchema.parse(raw))
            .catch((): PersonaRoute | undefined => undefined)
            .then((route) => {
                if (state.inflight?.text === text) {
                    state.inflight = undefined;
                }
                if (route !== undefined) {
                    state.answer.value = { text, route };
                }
                return route;
            });
        state.inflight = { text, promise };
        return promise;
    };

    // The draft, settled: a pause in typing on an eligible chat asks for the words as they stand.
    watch(
        () => [conversation(), draft().trim(), eligible(conversation())] as const,
        ([chat, text, askable]) => {
            const state = stateOf(chat);
            clearTimeout(state.timer);
            state.timer = undefined;
            if (!askable || text.length < MIN_CHARS || state.answer.value?.text === text || state.inflight?.text === text) {
                return;
            }
            state.timer = setTimeout(() => {
                state.timer = undefined;
                // Re-read at the moment of firing: the chat may have been sent, pinned or switched since.
                if (eligible(chat) && draft().trim() === text) {
                    void ask(chat, text);
                }
            }, SETTLE_MS);
        },
        { immediate: true },
    );

    const cardOf = (id: string | undefined): Persona | undefined => (id === undefined ? undefined : personas.value.find((persona) => persona.id === id));

    /* THE CARD GOES ON, and its model with it. `actsAs` is the same ref the pill writes, so everything that
     * reads the pill (the note under the composer, the turn body, the tab record) sees a routed card exactly as
     * it sees a picked one. */
    const wear = (chat: Conversation, card: Persona): void => {
        chat.actsAs.value = card.id;
        const head = personaModels(card, roleSources.value)[0];
        if (head !== undefined) {
            chat.wearModel(head);
        }
    };

    const preview = computed<PersonaRoutePreview | undefined>(() => {
        const chat = conversation();
        const state = stateOf(chat);
        const card = cardOf(state.answer.value?.route.persona);
        if (card === undefined || !open(chat)) {
            return undefined;
        }
        const reason = state.answer.value?.route.reason ?? ``;
        const auto = mode.value === `auto`;
        if (state.held.value) {
            // Only `auto` has a hold worth drawing: in `suggest` nothing was going to happen anyway.
            return auto ? { kind: `held`, persona: card, reason } : undefined;
        }
        return { kind: auto ? `route` : `suggest`, persona: card, reason };
    });

    const press = (): void => {
        const chat = conversation();
        const state = stateOf(chat);
        const shown = preview.value;
        if (shown === undefined) {
            return;
        }
        if (shown.kind === `suggest`) {
            wear(chat, shown.persona);
            return;
        }
        state.held.value = shown.kind === `route`;
    };

    const byHand = (): void => {
        stateOf(conversation()).held.value = true;
    };

    const beforeSend = (text: string): Promise<void> | undefined => {
        const chat = conversation();
        const trimmed = text.trim();
        if (mode.value !== `auto` || !eligible(chat) || trimmed.length < MIN_CHARS) {
            return undefined;
        }
        const state = stateOf(chat);
        clearTimeout(state.timer);
        state.timer = undefined;
        /* The freshest reading there is within the wait, else the latest one there was: the text only grew
         * since that one, so it is still a fair reading, and a send held past the wait for a better one is a
         * send the user is watching not go. */
        const fresh = ask(chat, trimmed);
        const wait = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), SEND_WAIT_MS));
        return Promise.race([fresh, wait]).then((route) => {
            const card = cardOf((route ?? state.answer.value?.route)?.persona);
            if (card !== undefined && eligible(chat)) {
                wear(chat, card);
            }
        });
    };

    return { preview, press, byHand, beforeSend };
};
