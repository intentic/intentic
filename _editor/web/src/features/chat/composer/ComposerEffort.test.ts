// The meter beside the model pill, while Auto is armed. Effort is part of the one reading Auto does, and the ladder
// would be the FALLBACK model's rather than the one that will run — so there is no meter at all. Same rule
// ChatModelPicker keeps for the rest of the run settings under Auto; this is the control that lives outside it.
import "@intentic/testing/dom";
import { type AgentProvider, capabilitiesOf } from "@intentic/sandbox-contract";
import { type App, computed, createApp, h, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";
import type { Conversation } from "../session/conversation";
import { effortsFor } from "../models/run-settings/effortScale";
import ComposerEffort from "./ComposerEffort.vue";

const PROVIDER = `claude` as const satisfies AgentProvider;
const MODEL = `a-model`;
// The rung the chat holds: a pick made before Auto was armed, which is exactly the state under test.
const HELD = `high`;

// Only what this component binds: the refs it reads and the one write it makes.
const conversationOf = (auto: boolean): Conversation =>
    ({
        selection: {
            provider: ref(PROVIDER),
            model: ref(MODEL),
            thinking: ref(false),
            effort: computed(() => HELD),
            auto: ref(auto),
            capabilities: computed(() => capabilitiesOf(PROVIDER, `claude-code`)),
            apply: jest.fn(),
        },
    }) as unknown as Conversation;

let app: App | undefined;
const mount = (auto: boolean): { element: HTMLElement; conversation: Conversation } => {
    const element = document.createElement(`div`);
    document.body.append(element);
    const held = conversationOf(auto);
    app = createApp({ render: () => h(ComposerEffort, { conversation: held }) });
    app.component(`Icon`, IconStub);
    app.mount(element);
    return { element, conversation: held };
};

// The rungs themselves (pointer build: one button per tier).
const rungs = (element: HTMLElement): HTMLButtonElement[] => [...element.querySelectorAll<HTMLButtonElement>(`button.composer-effort-seg`)];
// The word beside them; the invisible siblings are the width reservation, not what a reader sees.
const word = (element: HTMLElement): string | undefined => element.querySelector(`span.grid > span:not(.invisible)`)?.textContent ?? undefined;

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`draws no meter at all while Auto is armed`, () => {
    const { element } = mount(true);

    // Withheld rather than empty: this model's ladder exists, and the chat is simply not the one answering for it.
    expect(effortsFor(PROVIDER, MODEL, false).length).toBeGreaterThan(1);
    expect(element.querySelector(`[role="group"]`)).toBeNull();
    expect(rungs(element)).toHaveLength(0);
    expect(word(element)).toBeUndefined();
});

it(`is the chat's own control again the moment Auto is off`, () => {
    const { element, conversation } = mount(false);
    const offered = effortsFor(PROVIDER, MODEL, false);

    expect(rungs(element)).toHaveLength(offered.length);
    expect(word(element)).toBe(offered.find((option) => option.value === HELD)?.label);
    expect(rungs(element)[offered.findIndex((option) => option.value === HELD)]?.getAttribute(`aria-pressed`)).toBe(`true`);

    rungs(element)[0]!.click();
    expect(conversation.selection.apply).toHaveBeenCalledWith({ kind: `setEffort`, effort: offered[0]!.value });
});
