import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import type { AgentCommand, AgentProvider, Persona, RunnerSummary } from "@intentic/sandbox-contract";
import { hoisted } from "@intentic/testing/bun";
import { afterEach, describe, expect, it, jest, mock } from "bun:test";
import { computed, createApp, h, nextTick, ref } from "vue";
import * as catalogOriginal from "../../models/useChat-catalog";
import { runningTurn } from "../../../../testing/runningTurn";

// Pins the two lists over the composer: what an `@` at the caret offers and withholds, what a pick writes into the
// draft and where the caret lands, and what a leading `/` lists and runs.

// Asked for the provider's commands; a test reads whether the composer asked.
const { ensureProviderCommands } = hoisted(() => ({ ensureProviderCommands: mock<(target: AgentProvider) => Promise<void>>(async () => undefined) }));
mock.module("../../models/useChat-catalog", () => ({ ...catalogOriginal, ensureProviderCommands }));

const { useComposerPopovers } = await import("./composerPopovers");
const { Conversation } = await import("../../session/conversation");
const { conversationView } = await import("../useChat-view");

const COMMANDS: AgentCommand[] = [
    { name: `review`, description: `Review the diff.` },
    { name: `release`, description: `Cut a release.` },
];
const PERSONAS: Persona[] = [{ id: `backend`, label: `Backend`, capabilities: [] }];

let unmount: (() => void) | undefined;
const composerOf = () => {
    const chat = new Conversation(`c1`);
    const view = conversationView(computed(() => chat));
    const input = ref<HTMLTextAreaElement | null>(document.body.appendChild(document.createElement(`textarea`)));
    const host = {
        view,
        input,
        grow: mock(),
        personas: ref(PERSONAS),
        pickPersona: mock(),
        placement: { remote: ref(false), shown: ref(true), runners: ref<RunnerSummary[]>([]) },
        steered: ref(false),
        isGuest: ref(false),
    };
    let lists: ReturnType<typeof useComposerPopovers> | undefined;
    const app = createApp({
        setup: () => {
            lists = useComposerPopovers(host);
            return () => h(`div`);
        },
    });
    app.mount(document.createElement(`div`));
    unmount = () => app.unmount();
    // Types the whole draft with the caret at its end, as the textarea reports it.
    const type = (text: string): void => {
        chat.draft.value = text;
        lists!.caret.value = text.length;
    };
    return { chat, host, type, lists: lists! };
};

afterEach(() => {
    unmount?.();
    unmount = undefined;
    document.body.innerHTML = ``;
    ensureProviderCommands.mockClear();
    jest.useRealTimers();
    resetSandboxScope();
});

describe(`the @ list`, () => {
    it(`opens at a token under the caret, and stays dismissed until the token changes`, async () => {
        const { type, lists } = composerOf();
        type(`look at @sr`);
        expect(lists.activeMention.value?.query).toBe(`sr`);
        expect(lists.mentionOpen.value).toBe(true);

        lists.popoverDismissed.value = true;
        expect(lists.mentionOpen.value).toBe(false);

        type(`look at @src`);
        await nextTick();
        expect(lists.mentionOpen.value).toBe(true);
    });

    it(`offers what the row offers, and withholds what it refuses`, () => {
        const { chat, host, lists } = composerOf();
        const offered = (): string[] =>
            Object.entries(lists.quickSources.value)
                .filter(([, source]) => source !== undefined)
                .map(([kind]) => kind);
        expect(offered()).toEqual([`persona`, `sandbox`, `model`, `effort`]);

        // Placement latches with the branch once the board has seen the chat; Auto owns the effort question.
        chat.registered.value = true;
        chat.selection.apply({ kind: `set`, picks: { auto: true } });
        expect(offered()).toEqual([`persona`, `model`]);

        // A workflow badge greys the setting pills, and the list withholds the same kinds.
        host.steered.value = true;
        expect(offered()).toEqual([]);
        expect(lists.filesOffered.value).toBe(true);

        // Another box's chat: its files and personas are that box's.
        host.steered.value = false;
        host.placement.remote.value = true;
        expect(offered()).toEqual([`model`]);
        expect(lists.filesOffered.value).toBe(false);
    });

    it(`lists only the running provider's models mid-turn`, () => {
        const { chat, lists } = composerOf();

        runningTurn(chat.turn);

        expect(lists.quickSources.value.model?.entries.every((entry) => entry.provider === chat.selection.provider.value)).toBe(true);
    });

    it(`is never offered to a guest`, () => {
        const { host, type, lists } = composerOf();
        host.isGuest.value = true;

        type(`@src`);

        expect(lists.mentionOpen.value).toBe(false);
    });
});

describe(`an @ pick`, () => {
    it(`writes a file as its @path and lands the caret after it`, async () => {
        const { chat, host, type, lists } = composerOf();
        type(`look at @sr`);

        lists.pickMention({ kind: `file`, key: `src/app.ts`, path: `src/app.ts` });
        await nextTick();

        expect(chat.draft.value).toBe(`look at @src/app.ts `);
        expect(lists.caret.value).toBe(`look at @src/app.ts `.length);
        expect(document.activeElement).toBe(host.input.value);
        expect(host.grow).toHaveBeenCalledTimes(1);
    });

    it(`goes through the setting's own setter, leaves no text, and pulses that pill once`, async () => {
        jest.useFakeTimers();
        const { chat, type, lists } = composerOf();
        type(`@eff`);

        lists.pickMention({ kind: `effort`, key: `effort:low`, label: `Low`, detail: undefined, value: `low`, current: false });
        await nextTick();

        expect(chat.selection.effortPick.value).toBe(`low`);
        expect(chat.draft.value).toBe(``);
        expect(lists.flashed.value).toBe(`effort`);
        jest.advanceTimersByTime(700);
        expect(lists.flashed.value).toBeUndefined();
    });

    it(`picks a persona the way its pill does`, () => {
        const { host, type, lists } = composerOf();
        type(`@back`);

        lists.pickMention({ kind: `persona`, key: `persona:backend`, label: `Backend`, detail: undefined, id: `backend`, current: false });

        expect(host.pickPersona.mock.calls).toEqual([[`backend`]]);
        expect(lists.flashed.value).toBe(`persona`);
    });
});

describe(`the / list`, () => {
    it(`lists the commands the first token could still become, and writes the picked one in`, async () => {
        const { chat, type, lists } = composerOf();
        chat.availableCommands.value = COMMANDS;

        type(`/re`);
        expect(lists.commandOpen.value).toBe(true);
        expect(lists.commandMatches.value.map((command) => command.name)).toEqual([`review`, `release`]);

        type(`/rev`);
        expect(lists.commandMatches.value.map((command) => command.name)).toEqual([`review`]);

        lists.caret.value = 1;
        chat.draft.value = `/ the auth module`;
        lists.pickCommand(`review`);
        await nextTick();
        expect(chat.draft.value).toBe(`/review the auth module`);
        expect(lists.caret.value).toBe(`/review `.length);
    });

    it(`says a draft runs as a command only when its whole first word is one`, () => {
        const { chat, type, lists } = composerOf();
        chat.availableCommands.value = COMMANDS;

        type(`/review this`);
        expect(lists.commandRun.value?.name).toBe(`review`);

        type(`/rev this`);
        expect(lists.commandRun.value).toBeUndefined();
    });

    it(`asks for the provider's commands only while this composer has none`, async () => {
        const { chat, type } = composerOf();
        expect(ensureProviderCommands.mock.calls).toEqual([[`claude`]]);

        chat.availableCommands.value = COMMANDS;
        type(`/`);
        await nextTick();

        expect(ensureProviderCommands).toHaveBeenCalledTimes(1);
    });
});

describe(`a recalled message`, () => {
    it(`fills the box with the caret at its end, and keeps the lists closed over it`, async () => {
        const { chat, lists } = composerOf();

        lists.recallInto(`@src what changed`);
        await nextTick();

        expect(chat.draft.value).toBe(`@src what changed`);
        expect(lists.caret.value).toBe(`@src what changed`.length);
        expect(lists.popoverDismissed.value).toBe(true);
        expect(lists.mentionOpen.value).toBe(false);
    });
});
