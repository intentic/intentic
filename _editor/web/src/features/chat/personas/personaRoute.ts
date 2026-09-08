import { type Persona, type PersonaRoute, PersonaRouteSchema, mentionPaths, parsePinned, personaModels, pinnedModelLabel } from "@intentic/sandbox-contract";
import { computed, ref, type Ref } from "vue";
import { jsonBody } from "../../sandbox/client/jsonBody";
import { sandboxJson } from "../../sandbox/client/sandboxClient";
import { usePersonas } from "../../sandbox/personas/usePersonas";
import { useSandboxSettings } from "../../sandbox/overview/useSandboxSettings";
import type { Conversation } from "../session/conversation";
import { roleSources } from "../accounts/roleModel";

// Which persona a new chat belongs to, asked of the daemon once, on the message the user actually sent. Never on a
// draft: nothing about a half-typed message says it is finished, so reading one spends the owner's allowance on words
// they are still writing.
// The send waits for the answer, since the card decides the tree, accounts and model of the very turn being sent; the
// wait is drawn while it runs (a spinning transcript notice, rewritten in place with the verdict and the model that
// gave it), because a model call the owner cannot see is a bill they cannot question.
// Putting the card on also moves the model to its ladder's head (Conversation.wearModel). State lives per
// conversation, not persisted with the tab.

// How long a send waits for the reading before going out unrouted. Longer than the daemon's own deadline
// (persona-router.ts ROUTE_DEADLINE_MS), so a slow model is given up by the side that can say why, not by this timer.
export const SEND_WAIT_MS = 7_000;
// Fewer characters than this isn't a routable message, and isn't worth a model call.
const MIN_CHARS = 12;

interface RouteState {
    // When the reading in flight started, for the notice's ticking clock; undefined between readings.
    readonly since: Ref<number | undefined>;
    // Chat was pointed at a persona (or at "Anyone") by hand: nothing is asked or applied again.
    readonly held: Ref<boolean>;
    // The chat has had its one reading; a second message never buys another.
    asked: boolean;
}

const states = new WeakMap<Conversation, RouteState>();
const stateOf = (chat: Conversation): RouteState => {
    let state = states.get(chat);
    if (state === undefined) {
        state = { since: ref(undefined), held: ref(false), asked: false };
        states.set(chat, state);
    }
    return state;
};

// The reading a notice row is spinning on, read by ChatMessageView through `noticeWait`. Undefined once it settles.
export const personaRouteWait = (chat: Conversation): { readonly since: number } | undefined => {
    const since = stateOf(chat).since.value;
    return since === undefined ? undefined : { since };
};

export interface PersonaRouting {
    // A manual pick at the pill, including "Anyone": overrules routing for this chat.
    readonly byHand: () => void;
    // What a send waits for, or undefined for send-now. Capped at SEND_WAIT_MS, resolving once the card is (or isn't)
    // put on.
    readonly beforeSend: (text: string) => Promise<void> | undefined;
}

// Paths the daemon can match a card against: uploads first, then @-mentions, deduped. No folder, since a
// composer-opened chat has none.
const pathsOf = (chat: Conversation, text: string): string[] => {
    const uploaded = chat.attachments.value.map((file) => file.path);
    return [...uploaded, ...mentionPaths(text).filter((path) => !uploaded.includes(path))];
};

// What the reading cost, named: the model that answered, or nothing at all when none was reached.
const spent = (route: PersonaRoute | undefined): string => {
    const choice = route?.model === undefined ? undefined : parsePinned(route.model);
    return choice === undefined ? `` : ` Read by ${pinnedModelLabel(choice)}.`;
};

// The settled line: what came back, whether it was put on, and what the reading cost. Said whether or not a card was
// named, since the call was paid for either way.
const verdictLine = (card: Persona | undefined, route: PersonaRoute | undefined, applied: boolean): string => {
    if (route === undefined) {
        return `Couldn't read which persona this chat belongs to in time, so it stays open to everything.`;
    }
    if (card === undefined) {
        return `No persona matched, so this chat acts as everyone. ${route.reason}${spent(route)}`;
    }
    const name = card.label ?? card.id;
    return applied
        ? `Acting as ${name}. ${route.reason}${spent(route)}`
        : `${name} matched, but this chat was pointed somewhere by hand first, so nothing moved.${spent(route)}`;
};

export const usePersonaRoute = (conversation: () => Conversation): PersonaRouting => {
    const { settings } = useSandboxSettings();
    const { personas } = usePersonas();
    // Off until settings load, so no call fires on a guess about a setting the owner may have turned off. With no
    // cards there is nothing to route onto, and the round trip is skipped rather than answered `none`.
    const on = computed(() => settings.value?.personaRouting === true && personas.value.length > 0);

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

    const byHand = (): void => {
        stateOf(conversation()).held.value = true;
    };

    // A failed call reads as no answer rather than an error: the chat opens unrouted and says so.
    const ask = (chat: Conversation, text: string): Promise<PersonaRoute | undefined> =>
        sandboxJson(`/personas/route`, jsonBody(`POST`, { prompt: text, paths: pathsOf(chat, text) }))
            .then((raw) => PersonaRouteSchema.parse(raw))
            .catch((): PersonaRoute | undefined => undefined);

    const beforeSend = (text: string): Promise<void> | undefined => {
        const chat = conversation();
        const state = stateOf(chat);
        const trimmed = text.trim();
        // One reading per chat, on a turnless chat in this sandbox that nobody has pointed anywhere by hand.
        const askable =
            on.value &&
            !state.asked &&
            !state.held.value &&
            chat.box.value === undefined &&
            chat.messages.value.length === 0 &&
            chat.actsAs.value === undefined &&
            trimmed.length >= MIN_CHARS;
        if (!askable) {
            return undefined;
        }
        state.asked = true;
        state.since.value = Date.now();
        const noticeId = chat.notice(`Reading which persona this chat belongs to: one call on the persona-routing model.`, { noticeWait: `personaRoute` });
        const wait = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), SEND_WAIT_MS));
        return Promise.race([ask(chat, trimmed), wait]).then((route) => {
            state.since.value = undefined;
            const card = cardOf(route?.persona);
            // Re-checked: the pill may have been pointed somewhere by hand while the reading ran.
            const applied = card !== undefined && !state.held.value && chat.actsAs.value === undefined;
            if (applied) {
                wear(chat, card);
            }
            chat.reword(noticeId, verdictLine(card, route, applied), { noticeWait: undefined });
        });
    };

    return { byHand, beforeSend };
};
