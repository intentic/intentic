import { watch } from "vue";
import { type ModelChoice, requestModelPick } from "./hostModelPicker";
import { loadProviderModels } from "./useChat-catalog";
import type { Conversation } from "../session/conversation";
import { usePaneView } from "../panel/useChat-view";
import { focusComposer } from "../tabs/useChat-tabs";

// The model list reached from somewhere other than the composer's own pill (the account gate, a spent trial, a turn a
// model's refusal stopped partway): the shell's picker opens anchored to the press, and its answer applies to this
// pane's conversation exactly as a pick from the composer would. The conversation keeps its history and its changes.
//
// EVERY DOOR HERE IS "ANOTHER MODEL", so the list opens with nothing staged. It used to open on the chat's own pair, the
// one that cannot run, and "Use this model" pressed without touching a row handed that pair straight back: the pick
// changed nothing, and the panel closed as though it had (2026-11-06, a chat left on an API key its owner had removed).
// With nothing staged the bar says to choose a model, and its press waits for a row.
//
// A PICK IS NEVER DROPPED. A pick onto another provider is refused while this window streams a turn (selectionReducer:
// a provider switch retires the session the turn is running in), and the shell's list, unlike the composer's, cannot
// grey those rows: the press closed the list and nothing happened for as long as the turn ran. On that chat the turn was
// parked in a two-hour subagent wait on a key that no longer existed, and every pick for eight minutes went nowhere. So
// a pick the reducer would refuse is held until the turn ends and applied then; a door whose turn cannot succeed
// (`stopsTurn`: the provider it runs on is gone) stops it first, so the pick lands now.

// How long a stop-and-switch press waits for the stopped turn's stream to close before handing back; the pick still
// applies whenever it does close.
const STOP_WAIT_MS = 15_000;

export interface PaneModelPickOptions {
    // The live turn cannot succeed (the provider it runs on is no longer connected): a pick onto another provider stops
    // it, rather than waiting for it to fail on its own.
    readonly stopsTurn?: boolean;
}

// The pick, applied to the conversation it was made for (the pane may show another one by the time a held pick lands).
// The account goes with the model, as the composer's own list sends it (selectionReducer selectModel): onto another
// provider it rides the next turn, which names it there. Applied on its own after the model, it asked the daemon to move
// the conversation it still holds on the provider being left, and a chat on a spent API key came out pinned to a Claude
// sign-in while still running on the key (2026-11-07).
export const applyChoice = (
    conversation: { readonly selection: Pick<Conversation[`selection`], `apply`> },
    choice: ModelChoice,
    loadModels: (provider: ModelChoice[`provider`]) => Promise<void> = loadProviderModels,
): void => {
    const pick = { provider: choice.provider, value: choice.model };
    conversation.selection.apply(choice.account === undefined ? { kind: `selectModel`, pick } : { kind: `selectModel`, pick, account: choice.account });
    // The catalog can be stale (loaded before the account connected); cheap, since the daemon caches it.
    void loadModels(choice.provider);
    if (choice.harness !== undefined) {
        conversation.selection.apply({ kind: `selectHarness`, harness: choice.harness });
    }
};

// Resolves once this window no longer streams the conversation's turn, or after `withinMs` with false; `then` runs at
// the stream's end either way, however long that takes. Not tied to a component's scope: the watcher stops itself.
const onceTurnEnds = (conversation: Conversation, then: () => void, withinMs?: number): Promise<boolean> =>
    new Promise((resolve) => {
        if (!conversation.turn.streaming.value) {
            then();
            resolve(true);
            return;
        }
        const timer = withinMs === undefined ? undefined : setTimeout(() => resolve(false), withinMs);
        const stop = watch(conversation.turn.streaming, (streaming) => {
            if (streaming) {
                return;
            }
            stop();
            clearTimeout(timer);
            then();
            resolve(true);
        });
    });

export const usePaneModelPick = (options: PaneModelPickOptions = {}): ((anchor: HTMLElement) => Promise<void>) => {
    const view = usePaneView();
    return async (anchor) => {
        const choice = await requestModelPick({ anchor, provider: ``, model: `` });
        if (choice === undefined) {
            return;
        }
        const conversation = view.conversation.value;
        const crosses = choice.provider !== conversation.selection.provider.value;
        // Whoever runs the doomed turn (this window, or another the card names), it is ended: left running it fails at
        // its next model call, whenever that comes.
        const stopping = crosses && options.stopsTurn === true && view.turnStoppable.value;
        if (stopping) {
            view.stop();
        }
        if (!crosses || !conversation.turn.streaming.value) {
            applyChoice(conversation, choice);
            focusComposer();
            return;
        }
        if (!stopping) {
            void onceTurnEnds(conversation, () => applyChoice(conversation, choice));
            return;
        }
        const ended = await onceTurnEnds(conversation, () => applyChoice(conversation, choice), STOP_WAIT_MS);
        if (ended) {
            focusComposer();
        }
    };
};
