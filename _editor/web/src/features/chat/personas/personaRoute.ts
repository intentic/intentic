import { type Persona, type PersonaRoute, PersonaRouteSchema, mentionPaths, personaModels } from "@intentic/sandbox-contract";
import { computed, type ComputedRef, type Ref, ref, watch } from "vue";
import { jsonBody } from "../../sandbox/client/jsonBody";
import { sandboxJson } from "../../sandbox/client/sandboxClient";
import { usePersonas } from "../../sandbox/personas/usePersonas";
import { useSandboxSettings } from "../../sandbox/overview/useSandboxSettings";
import type { Conversation } from "../session/conversation";
import { roleSources } from "../accounts/roleModel";

// Which persona a new chat belongs to, asked of the daemon from the composer before the first turn: read once per
// settled draft while every gate holds (routing on, no turns yet, nobody pinned, this sandbox, enough words).
// - suggest: the answer is a chip; pressing it puts the card on. Nothing happens at send.
// - auto: applied at send unless declined first (`held`); a send that arrives early waits briefly, since context is
//   fixed on the opening turn.
// Putting the card on also moves the model to its ladder's head (Conversation.wearModel). State lives per conversation,
// not persisted with the tab.

// How long typing pauses before a draft counts as settled and gets read.
export const SETTLE_MS = 1_200;
// How long a send in `auto` waits for a reading in flight before going out anyway.
export const SEND_WAIT_MS = 4_000;
// Fewer characters than this isn't a routable message.
const MIN_CHARS = 12;

interface RouteState {
    // Latest daemon answer with the text it answered for; kept until a newer one lands.
    readonly answer: Ref<{ readonly text: string; readonly route: PersonaRoute } | undefined>;
    // User declined routing for this chat; nothing is asked, shown, or applied again.
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
    // suggest: the answer, offered; a press applies it. route: auto's answer, about to apply at send; a press declines
    // it. held: that decline; the same press lifts it.
    | { readonly kind: `suggest` | `route`; readonly persona: Persona; readonly reason: string }
    | { readonly kind: `held`; readonly persona: Persona; readonly reason: string };

export interface PersonaRouting {
    readonly preview: ComputedRef<PersonaRoutePreview | undefined>;
    // The chip's one press, whatever state it's in.
    readonly press: () => void;
    // A manual pick at the pill, including "Anyone": overrules routing for this chat.
    readonly byHand: () => void;
    // What a send waits for, or undefined for send-now; only an eligible `auto` chat waits, capped at SEND_WAIT_MS,
    // resolving once the card is (or isn't) put on.
    readonly beforeSend: (text: string) => Promise<void> | undefined;
}

// Paths the daemon can match a card against: uploads first, then @-mentions, deduped. No folder, since a
// composer-opened chat has none.
const pathsOf = (chat: Conversation, text: string): string[] => {
    const uploaded = chat.attachments.value.map((file) => file.path);
    return [...uploaded, ...mentionPaths(text).filter((path) => !uploaded.includes(path))];
};

export const usePersonaRoute = (conversation: () => Conversation, draft: () => string): PersonaRouting => {
    const { settings } = useSandboxSettings();
    const { personas } = usePersonas();
    // Off until settings load, so no call fires on a guess about a mode the owner may have disabled.
    const mode = computed(() => settings.value?.personaRouting ?? `off`);

    // A reading could still show for this chat: routing on, this sandbox, no turns, nobody pinned.
    const open = (chat: Conversation): boolean =>
        mode.value !== `off` && chat.box.value === undefined && chat.messages.value.length === 0 && chat.actsAs.value === undefined;
    // ...and could still be asked for and applied: open, and not declined.
    const eligible = (chat: Conversation): boolean => open(chat) && !stateOf(chat).held.value;

    // One reading per text: the same words are never asked twice, and an in-flight ask is joined, not repeated. A
    // failed call reads as no answer rather than an error.
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

    // A pause in typing on an eligible chat asks for the draft as it stands.
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
                // Re-checked at fire time: the chat may have been sent, pinned, or switched since.
                if (eligible(chat) && draft().trim() === text) {
                    void ask(chat, text);
                }
            }, SETTLE_MS);
        },
        { immediate: true },
    );

    const cardOf = (id: string | undefined): Persona | undefined => (id === undefined ? undefined : personas.value.find((persona) => persona.id === id));

    // Puts the card on and its model with it, through the same `actsAs` ref the pill writes, so a routed card and a
    // picked one look identical everywhere that reads it.
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
            // Only `auto` has a hold worth drawing; `suggest` was never going to act anyway.
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
        // Races the freshest reading against the wait; past it, the latest answer is still fair since the text has only
        // grown since then.
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
