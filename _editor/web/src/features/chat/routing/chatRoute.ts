import { type ChatRoute, type Persona, mentionPaths, parsePinned, personaModels } from "@intentic/sandbox-contract";
import { computed, ref, type Ref } from "vue";
import { sandboxRpc } from "../../sandbox/client/sandboxRpc";
import { usePersonas } from "../../sandbox/personas/usePersonas";
import { useSandboxSettings } from "../../sandbox/overview/useSandboxSettings";
import { useRole } from "../../sandbox/secrets/useRole";
import { modelLabelFor } from "../accounts/providerCatalog";
import { roleSources } from "../accounts/roleModel";
import type { Conversation } from "../session/conversation";

// What a new chat opens on — which persona it belongs to, and which model it runs on — asked of the daemon once, on the
// message the user actually sent. ONE call for both questions: they are read from the same message at the same moment,
// and a chat that wants both must not pay twice. Which halves are asked for is per chat: the model while it is on Auto,
// the persona while matching is on and nobody has pointed it anywhere by hand. Either can be the only one.
// Never on a draft: nothing about a half-typed message says it is finished, and reading one spends the owner's
// allowance on words they are still writing.
// The send waits for the answer, since both decide the very turn being sent; the wait is drawn while it runs (a
// spinning transcript notice, rewritten in place with the verdict and the model that gave it), because a model call
// the owner cannot see is a bill they cannot question.
// Asked once and never again: from the next turn both are ordinary picks the user owns, which is the whole bargain.
// State lives per conversation, persisted with the tab only as the `auto` flag itself.

// How long a send waits for the reading before going out on what the chat already had. Longer than the daemon's own
// deadline (chat-router.ts ROUTE_DEADLINE_MS), so a slow reading is given up by the side that can say why, not by this
// timer.
export const SEND_WAIT_MS = 7_000;
// Under this there is nothing to read for that half: a greeting is not a description of work, and fewer words still
// than that is not a message any persona's line can be matched against.
const MODEL_MIN_CHARS = 4;
const PERSONA_MIN_CHARS = 12;

// Which halves this reading is being paid for; both false means no call at all.
interface Want {
    readonly model: boolean;
    readonly persona: boolean;
}

// What the answer actually moved, re-checked after the reading rather than assumed from it.
interface Worn {
    // The persona put on by this reading; undefined when none was, for any reason.
    readonly persona?: Persona;
    // That persona named its own model, which outranks anything this reading chose.
    readonly carried: boolean;
    // The reading's own model pick was put on.
    readonly model: boolean;
}

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
export const chatRouteWait = (chat: Conversation): { readonly since: number } | undefined => {
    const since = stateOf(chat).since.value;
    return since === undefined ? undefined : { since };
};

export interface ChatRouting {
    // A manual pick at the persona pill, including "Anyone": overrules routing for this chat.
    readonly byHand: () => void;
    // What a send waits for, or undefined for send-now. Capped at SEND_WAIT_MS, resolving once the chat is (or isn't)
    // pointed. `editorContext` is the composer's own chip state, which lives there rather than on the conversation.
    readonly beforeSend: (text: string, editorContext: boolean) => Promise<void> | undefined;
}

// Paths the daemon can weigh the work against and match a persona on: uploads first, then @-mentions, deduped.
const pathsOf = (chat: Conversation, text: string): string[] => {
    const uploaded = chat.attachments.value.map((file) => file.path);
    return [...uploaded, ...mentionPaths(text).filter((path) => !uploaded.includes(path))];
};

// What the reading cost, named: the model that answered, or nothing at all when none was reached.
const spent = (route: ChatRoute): string => {
    const choice = route.judge === undefined ? undefined : parsePinned(route.judge);
    return choice === undefined ? `` : ` Read by ${modelLabelFor(choice.provider, choice.model)}.`;
};

const nameOf = (persona: Persona): string => persona.label ?? persona.id;

// Said whether or not a persona was named, since the call was paid for either way, and whether or not it was put on,
// since a chat pointed somewhere by hand while the reading ran is a thing the record should show.
const personaClause = (route: ChatRoute, worn: Worn, matched: Persona | undefined): readonly string[] => {
    const verdict = route.persona;
    if (verdict === undefined) {
        return [];
    }
    if (worn.persona !== undefined) {
        return [`Acting as ${nameOf(worn.persona)}.`, verdict.reason];
    }
    return matched === undefined
        ? [`No persona matched, so this chat acts as everyone.`, verdict.reason]
        : [`${nameOf(matched)} matched, but this chat was pointed somewhere by hand first, so nothing moved.`];
};

// A persona that names its own model has already answered which model this chat runs on; the reading's pick stands
// down rather than overruling it, and the line says so instead of naming a model nothing is running.
const modelClause = (route: ChatRoute, worn: Worn): readonly string[] => {
    const verdict = route.model;
    if (verdict === undefined) {
        return [];
    }
    if (worn.carried && worn.persona !== undefined) {
        return [`${nameOf(worn.persona)} brings its own model, so this chat runs on that instead.`];
    }
    return worn.model ? [verdict.reason, `Every turn after this one stays on it until you change it.`] : [verdict.reason];
};

// Nothing came back inside the wait: each half says what the chat keeps instead.
const timedOut = (want: Want): string => {
    if (want.model && want.persona) {
        return `Couldn't read what this chat opens on in time, so it stays open to everything and runs on the model it already had.`;
    }
    return want.model
        ? `Couldn't choose a model for this chat in time, so it runs on the one it already had.`
        : `Couldn't read which persona this chat belongs to in time, so it stays open to everything.`;
};

const verdictLine = (route: ChatRoute | undefined, want: Want, worn: Worn, matched: Persona | undefined): string =>
    route === undefined ? timedOut(want) : `${[...personaClause(route, worn, matched), ...modelClause(route, worn)].join(` `)}${spent(route)}`;

// What the row says while the call is out: the halves it is paying for, named, since this is the bill the owner sees.
const noticeText = (want: Want): string => {
    if (want.model && want.persona) {
        return `Reading what this chat opens on: one call that picks both its persona and its model.`;
    }
    return want.model
        ? `Choosing which model this chat runs on: one call on the New chat routing list.`
        : `Reading which persona this chat belongs to: one call on the New chat routing list.`;
};

// A chat nothing has run in yet: the only state either question can be asked in, and the one the answers are free to
// decide anything from.
const fresh = (chat: Conversation, state: RouteState): boolean => !state.asked && chat.box.value === undefined && chat.transcript.messages.value.length === 0;

// Which halves this message is worth asking about. Each is a fact about the chat, not about the sandbox's settings:
// one already pointed at a model or a persona by hand has nothing left to ask about it.
const wanted = (chat: Conversation, state: RouteState, text: string, personaOn: boolean): Want => {
    const open = fresh(chat, state);
    return {
        model: open && chat.selection.auto.value && text.length >= MODEL_MIN_CHARS,
        persona: open && personaOn && !state.held.value && chat.selection.actsAs.value === undefined && text.length >= PERSONA_MIN_CHARS,
    };
};

// The persona this reading may actually put on: the one it named, unless a hand pointed the chat somewhere while the
// reading ran.
const takeable = (chat: Conversation, matched: Persona | undefined): Persona | undefined =>
    matched !== undefined && !stateOf(chat).held.value && chat.selection.actsAs.value === undefined ? matched : undefined;

// The reading's own model, worn as a pick the user owns from here on.
const wearPick = (chat: Conversation, pick: NonNullable<NonNullable<ChatRoute["model"]>["pick"]>): void => {
    chat.selection.apply({ kind: `wearModel`, pin: { provider: pick.provider, model: pick.model, ...(pick.effort === undefined ? {} : { effort: pick.effort }) } });
    // After wearModel, never before: pointing at a provider re-scopes the account to that provider's own remembered
    // one, which would throw away the account the judge just named.
    if (pick.account !== undefined) {
        chat.selection.apply({ kind: `set`, picks: { account: pick.account } });
    }
    // Marks the one turn the judge decided, so the ledger can be asked later whether the choice held.
    chat.selection.apply({ kind: `set`, picks: { autoPicked: true } });
};

export const useChatRoute = (conversation: () => Conversation): ChatRouting => {
    const { settings } = useSandboxSettings();
    const { personas } = usePersonas();
    const { isGuest } = useRole();
    // Off until settings load, so no call fires on a guess about a setting the owner may have turned off. With no
    // personas there is nothing to route onto, and the question is skipped rather than answered `none`. A guest is never
    // routed: its chat wears one of its own personas from the start, and the daemon refuses it the reading anyway.
    const personaOn = computed(() => settings.value?.personaRouting === true && personas.value.length > 0 && !isGuest.value);

    const cardOf = (id: string | undefined): Persona | undefined => (id === undefined ? undefined : personas.value.find((persona) => persona.id === id));

    const byHand = (): void => {
        stateOf(conversation()).held.value = true;
    };

    // A failed call reads as no answer rather than an error: the chat keeps what it had and says so.
    const ask = (chat: Conversation, text: string, want: Want, editorContext: boolean): Promise<ChatRoute | undefined> =>
        sandboxRpc.agent
            .routeChat({
                prompt: text,
                paths: pathsOf(chat, text),
                editorContext,
                planMode: chat.selection.modePick.value === `plan`,
                model: want.model,
                persona: want.persona,
            })
            .catch((): ChatRoute | undefined => undefined);

    // Puts the persona on and its model with it, through the same `actsAs` ref the pill writes, so a routed persona and
    // a picked one look identical everywhere that reads it.
    const wearPersona = (chat: Conversation, persona: Persona): boolean => {
        chat.selection.apply({ kind: `set`, picks: { actsAs: persona.id } });
        const head = personaModels(persona, roleSources.value)[0];
        if (head === undefined) {
            return false;
        }
        chat.selection.apply({ kind: `wearModel`, pin: head });
        return true;
    };

    // Applies what came back, re-checking each half against the chat as it is NOW: the pill and the picker may have
    // been used by hand while the reading ran, and a hand is the last word.
    const apply = (chat: Conversation, route: ChatRoute | undefined, matched: Persona | undefined): Worn => {
        const persona = takeable(chat, matched);
        const carried = persona !== undefined && wearPersona(chat, persona);
        const pick = route?.model?.pick;
        // `carried` first: a persona's own ladder outranks a model chosen for a chat that had no persona yet.
        const model = pick !== undefined && !carried && chat.selection.auto.value;
        if (model) {
            wearPick(chat, pick);
        }
        return { ...(persona === undefined ? {} : { persona }), carried, model };
    };

    const beforeSend = (text: string, editorContext: boolean): Promise<void> | undefined => {
        const chat = conversation();
        const state = stateOf(chat);
        const trimmed = text.trim();
        const want = wanted(chat, state, trimmed, personaOn.value);
        if (!want.model && !want.persona) {
            // Auto armed on a chat nothing will read disarms instead of leaving a question standing that nothing will
            // ever answer.
            if (chat.selection.auto.value) {
                chat.selection.apply({ kind: `setAuto`, auto: false });
            }
            return undefined;
        }
        state.asked = true;
        state.since.value = Date.now();
        const noticeId = chat.transcript.notice(noticeText(want), { noticeWait: `chatRoute` });
        const wait = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), SEND_WAIT_MS));
        return Promise.race([ask(chat, trimmed, want, editorContext), wait]).then((route) => {
            state.since.value = undefined;
            const matched = cardOf(route?.persona?.id);
            const worn = apply(chat, route, matched);
            // Auto is spent either way, but only where it was armed: it asked its one question, and what runs now is a
            // pick like any other.
            if (want.model) {
                chat.selection.apply({ kind: `setAuto`, auto: false });
            }
            chat.transcript.rewordNotice(noticeId, verdictLine(route, want, worn, matched), { noticeWait: undefined });
        });
    };

    return { byHand, beforeSend };
};
