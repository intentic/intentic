// Which model a chat's card and tab claim. A model picked while a reply runs applies from the next message, so the card
// keeps naming the one the reply went out under: a person saw the new model named, asked the agent which it was, and it
// said the old one.
import "@intentic/testing/dom";
import { unstubbed } from "@intentic/testing";
import { computed, ref, shallowRef } from "vue";
import { perProvider, providerModels } from "../../accounts/providerCatalog";
import type { ComposerSelection } from "../../session/composerSelection";
import type { Conversation } from "../../session/conversation";
import { UNPICKED } from "../../session/selectionReducer";
import { observeRoster, resetSandboxClock } from "../../../agents/fleet/sandboxClock";
import { liveOf, modelOrProvider } from "../cardView";
import { startedHere } from "../tabFacts";

beforeEach(() => {
    providerModels.value = {
        ...perProvider(() => []),
        claude: [
            { value: `claude-opus-5`, label: `Claude Opus 5` },
            { value: `claude-haiku-4-5`, label: `Claude Haiku 4.5` },
        ],
    };
});

// Only what the card reads of a conversation: the pick, the model the last turn went out under, what its runtime said.
// Anything else it reached for would throw with its own name.
const chat = (facts: { readonly picked: string; readonly sent: string | undefined; readonly reported: string | null }) => {
    const state = shallowRef({ ...UNPICKED, provider: `claude` as const, model: facts.picked, sentModel: facts.sent });
    const selection = unstubbed<ComposerSelection>(`selection`, {
        state,
        provider: computed(() => state.value.provider),
        model: computed(() => state.value.model),
    });
    return { conversation: unstubbed<Conversation>(`conversation`, { selection, activeModel: ref(facts.reported) }), agent: undefined };
};

test(`names the model the running reply was sent under, not the one picked for the next message`, () => {
    expect(modelOrProvider(chat({ picked: `claude-opus-5`, sent: `claude-haiku-4-5`, reported: null }))).toBe(`Claude Haiku 4.5`);
});

test(`names what the runtime reported over both, and the pick only before anything was sent`, () => {
    expect(modelOrProvider(chat({ picked: `claude-opus-5`, sent: `claude-opus-5`, reported: `claude-haiku-4-5` }))).toBe(`Claude Haiku 4.5`);
    expect(modelOrProvider(chat({ picked: `claude-opus-5`, sent: undefined, reported: null }))).toBe(`Claude Opus 5`);
});

// The rail counts a working chat on the sandbox's clock (sandboxClock.ts). A turn this browser sent starts on its own clock
// and is moved onto the sandbox's; one it attached to already started on the sandbox's, and moving it again counted a
// clock 96 s fast twice over.
test(`puts a working chat's start on the sandbox's clock once, whichever clock it started on`, () => {
    const NOW = 1_700_000_000_000;
    // The sandbox restamps a conversation at NOW - 96 s by its own clock, read here at NOW: this browser is 96 s fast.
    observeRoster([{ id: `a`, updatedAt: NOW - 100_000 }], [{ id: `a`, updatedAt: NOW - 96_000 }], NOW);
    const working = (onSandbox: boolean) => ({
        conversation: unstubbed<Conversation>(`conversation`, {
            turn: unstubbed<Conversation[`turn`]>(`turn`, {
                ending: computed(() => undefined),
                streaming: computed(() => true),
                turnStartedAt: computed(() => NOW - 1_000),
                turnOnSandboxClock: computed(() => onSandbox),
            }),
        }),
        agent: undefined,
    });

    try {
        expect(liveOf(working(false))?.since).toBe(NOW - 1_000 - 96_000);
        expect(liveOf(working(true))?.since).toBe(NOW - 1_000);
        // A tab's facts carry the start on this browser's clock, which the board moves onto the sandbox's once.
        expect(startedHere(working(false).conversation)).toBe(NOW - 1_000);
        expect(startedHere(working(true).conversation)).toBe(NOW - 1_000 + 96_000);
    } finally {
        resetSandboxClock();
    }
});
