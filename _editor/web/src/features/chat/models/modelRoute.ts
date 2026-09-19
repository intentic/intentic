import { type ModelRoute, ModelRouteSchema, mentionPaths, parsePinned, pinnedModelLabel } from "@intentic/sandbox-contract";
import { ref, type Ref } from "vue";
import { jsonBody } from "../../sandbox/client/jsonBody";
import { sandboxJson } from "../../sandbox/client/sandboxClient";
import type { Conversation } from "../session/conversation";

// Which model a chat on Auto runs on, asked of the daemon once, on the message the user actually sent. Never on a
// draft: nothing about a half-typed message says it is finished, and reading one spends the owner's allowance on words
// they are still writing.
// The send waits for the answer, since the pick decides the very turn being sent; the wait is drawn while it runs (a
// spinning transcript notice, rewritten in place with the verdict and the model that gave it), because a model call
// the owner cannot see is a bill they cannot question.
// Asked once and never again: from the next turn the model is an ordinary pick the user owns, which is the whole
// bargain of Auto. State lives per conversation, persisted with the tab only as the `auto` flag itself.

// How long a send waits for the reading before going out on the chat's own pick. Longer than the daemon's own deadline
// (model-router.ts ROUTE_DEADLINE_MS), so a slow model is given up by the side that can say why, not by this timer.
export const SEND_WAIT_MS = 7_000;
// Under this there is nothing to read: a greeting is not a description of work. Such a chat disarms Auto rather than
// keeping a question nothing will answer.
const MIN_CHARS = 4;

interface RouteState {
    // When the reading in flight started, for the notice's ticking clock; undefined between readings.
    readonly since: Ref<number | undefined>;
    // The chat has had its one reading; a second message never buys another.
    asked: boolean;
}

const states = new WeakMap<Conversation, RouteState>();
const stateOf = (chat: Conversation): RouteState => {
    let state = states.get(chat);
    if (state === undefined) {
        state = { since: ref(undefined), asked: false };
        states.set(chat, state);
    }
    return state;
};

// The reading a notice row is spinning on, read by ChatMessageView through `noticeWait`. Undefined once it settles.
export const modelRouteWait = (chat: Conversation): { readonly since: number } | undefined => {
    const since = stateOf(chat).since.value;
    return since === undefined ? undefined : { since };
};

export interface ModelRouting {
    // What a send waits for, or undefined for send-now. Capped at SEND_WAIT_MS, resolving once the model is (or isn't)
    // chosen. `editorContext` is the composer's own chip state, which lives there rather than on the conversation.
    readonly beforeSend: (text: string, editorContext: boolean) => Promise<void> | undefined;
}

// Paths the daemon can weigh the work against: uploads first, then @-mentions, deduped.
const pathsOf = (chat: Conversation, text: string): string[] => {
    const uploaded = chat.attachments.value.map((file) => file.path);
    return [...uploaded, ...mentionPaths(text).filter((path) => !uploaded.includes(path))];
};

// What the reading cost, named: the model that answered, or nothing at all when none was reached.
const spent = (route: ModelRoute | undefined): string => {
    const choice = route?.judge === undefined ? undefined : parsePinned(route.judge);
    return choice === undefined ? `` : ` Read by ${pinnedModelLabel(choice)}.`;
};

// The settled line. Said whether or not a model was named, since the call was paid for either way, and whether or not
// it was applied, since a chat pointed somewhere by hand while the reading ran is a thing the record should show.
const verdictLine = (route: ModelRoute | undefined, applied: boolean): string => {
    if (route === undefined) {
        return `Couldn't choose a model for this chat in time, so it runs on the one it already had.`;
    }
    if (route.pick === undefined || !applied) {
        return `${route.reason}${spent(route)}`;
    }
    return `${route.reason} Every turn after this one stays on it until you change it.${spent(route)}`;
};

export const useModelRoute = (conversation: () => Conversation): ModelRouting => {
    // A failed call reads as no answer rather than an error: the chat runs on its own pick and says so.
    const ask = (chat: Conversation, text: string, editorContext: boolean): Promise<ModelRoute | undefined> =>
        sandboxJson(
            `/agent/route-model`,
            jsonBody(`POST`, { prompt: text, paths: pathsOf(chat, text), editorContext, planMode: chat.modePick.value === `plan` }),
        )
            .then((raw) => ModelRouteSchema.parse(raw))
            .catch((): ModelRoute | undefined => undefined);

    const beforeSend = (text: string, editorContext: boolean): Promise<void> | undefined => {
        const chat = conversation();
        const state = stateOf(chat);
        const trimmed = text.trim();
        if (!chat.auto.value || state.asked) {
            return undefined;
        }
        // One reading per chat, on a turnless chat in this sandbox. Anything else disarms Auto instead of leaving a
        // question standing that nothing will ever answer: a chat already under way has a model, and it is running.
        if (chat.box.value !== undefined || chat.messages.value.length > 0 || trimmed.length < MIN_CHARS) {
            chat.setAuto(false);
            return undefined;
        }
        state.asked = true;
        state.since.value = Date.now();
        const noticeId = chat.notice(`Choosing which model this chat runs on: one call on the Auto model-choice list.`, { noticeWait: `modelRoute` });
        const wait = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), SEND_WAIT_MS));
        return Promise.race([ask(chat, trimmed, editorContext), wait]).then((route) => {
            state.since.value = undefined;
            // Re-checked: the picker may have been used by hand while the reading ran, and a hand is the last word.
            const applied = route?.pick !== undefined && chat.auto.value;
            if (applied && route?.pick !== undefined) {
                const pick = route.pick;
                chat.wearModel({ provider: pick.provider, model: pick.model, ...(pick.effort === undefined ? {} : { effort: pick.effort }) });
                // After wearModel, never before: pointing at a provider re-scopes the account to that provider's own
                // remembered one, which would throw away the account the judge just named.
                if (pick.account !== undefined) {
                    chat.account.value = pick.account;
                }
                // Marks the one turn the judge decided, so the ledger can be asked later whether the choice held.
                chat.autoPicked.value = true;
            }
            // Auto is spent either way. It asked its one question; what runs now is a pick like any other.
            chat.setAuto(false);
            chat.reword(noticeId, verdictLine(route, applied), { noticeWait: undefined });
        });
    };

    return { beforeSend };
};
