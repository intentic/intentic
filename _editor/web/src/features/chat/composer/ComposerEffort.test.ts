// @vitest-environment jsdom
// The meter beside the model pill, while Auto is armed. Effort is part of the one reading Auto does, and the ladder
// on screen is the FALLBACK model's, not the one that will run — so no rung is lit and none can be pressed. Same rule
// ChatModelPicker keeps for the rest of the run settings under Auto; this is the control that lives outside it.
import { type AgentProvider, capabilitiesOf } from "@intentic/sandbox-contract";
import { afterEach, expect, it, vi } from "vitest";
import { type App, computed, createApp, h, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";
import type { Conversation } from "../session/conversation";
import { effortsFor } from "../models/run-settings/effortScale";
import ComposerEffort from "./ComposerEffort.vue";

const PROVIDER = `claude` as const satisfies AgentProvider;
const MODEL = `a-model`;
// The rung the chat holds: a pick the user made before arming Auto, which is exactly the state under test.
const HELD = `high`;

// Only what this component binds: the four refs it reads and the one write it makes.
const conversationOf = (auto: boolean): Conversation =>
    ({
        provider: ref(PROVIDER),
        model: ref(MODEL),
        thinking: ref(false),
        effort: computed(() => HELD),
        auto: ref(auto),
        capabilities: computed(() => capabilitiesOf(PROVIDER, `claude-code`)),
        setEffort: vi.fn(),
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
const word = (element: HTMLElement): string => element.querySelector(`span.grid > span:not(.invisible)`)?.textContent ?? ``;

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`answers nothing about effort while Auto is armed`, () => {
    const { element } = mount(true);

    // The ladder is still drawn — the row must not jump when Auto disarms on send — but it holds no answer.
    expect(rungs(element)).toHaveLength(effortsFor(PROVIDER, MODEL, false).length);
    expect(rungs(element).some((rung) => rung.getAttribute(`aria-pressed`) === `true`)).toBe(false);
    expect(word(element)).toBe(`Auto`);
});

it(`takes no press while Auto is armed`, () => {
    const { element, conversation } = mount(true);

    expect(rungs(element).every((rung) => rung.disabled)).toBe(true);
    for (const rung of rungs(element)) {
        rung.click();
    }
    expect(conversation.setEffort).not.toHaveBeenCalled();
});

it(`is the chat's own control again the moment Auto is off`, () => {
    const { element, conversation } = mount(false);
    const offered = effortsFor(PROVIDER, MODEL, false);

    expect(word(element)).toBe(offered.find((option) => option.value === HELD)?.label);
    expect(rungs(element)[offered.findIndex((option) => option.value === HELD)]?.getAttribute(`aria-pressed`)).toBe(`true`);

    rungs(element)[0]!.click();
    expect(conversation.setEffort).toHaveBeenCalledWith(offered[0]!.value);
});
