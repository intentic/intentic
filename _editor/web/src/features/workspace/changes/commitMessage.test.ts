import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { nextTick, ref } from "vue";

// vi.hoisted lets these exist before the mocked imports below, which read them at import time.
const { active, stored } = vi.hoisted(() => {
    const state = { active: { sandboxId: undefined as string | undefined }, stored: new Map<string, string>() };
    return state;
});

vi.mock("../../sandbox/client/useSandbox", async () => {
    // Imported inside the factory since mocks hoist above this file's own imports; renamed to avoid shadowing `ref`.
    const { ref: vueRef } = await import("vue");
    return { useSandbox: () => ({ activeSandboxId: vueRef<string | undefined>(active.sandboxId) }) };
});

vi.stubGlobal(`localStorage`, {
    getItem: (key: string): string | null => stored.get(key) ?? null,
    setItem: (key: string, value: string): void => void stored.set(key, value),
    removeItem: (key: string): void => void stored.delete(key),
});

import { boxIsYours, clearFilledMessage, commitMessage, fillCommitMessage, followFilledMessage, nameCommitAfter, namedAfter } from "./commitMessage";

describe(`the commit box`, () => {
    beforeEach(() => {
        commitMessage.value = ``;
    });

    test(`starts empty, nothing fills it on its own`, () => {
        expect(commitMessage.value).toBe(``);
    });

    test(`a legend click files its subject in`, () => {
        fillCommitMessage(`fix: cascading markers`);
        expect(commitMessage.value).toBe(`fix: cascading markers`);
    });

    test(`clicking another session replaces the line the first one left`, () => {
        fillCommitMessage(`fix: cascading markers`);
        fillCommitMessage(`feat: add chat tab icons`);
        expect(commitMessage.value).toBe(`feat: add chat tab icons`);
    });

    test(`clicking off takes back the line it filed`, () => {
        fillCommitMessage(`fix: cascading markers`);
        clearFilledMessage();
        expect(commitMessage.value).toBe(``);
    });

    test(`a typed message is never overwritten by a fill`, () => {
        commitMessage.value = `chore: my own subject`;
        fillCommitMessage(`fix: cascading markers`);
        expect(commitMessage.value).toBe(`chore: my own subject`);
    });

    test(`a typed message is never taken back by a clear`, () => {
        commitMessage.value = `chore: my own subject`;
        clearFilledMessage();
        expect(commitMessage.value).toBe(`chore: my own subject`);
    });

    test.each([[` `], [`\n`], [`   \n  `]])(`a box holding only %j is still fillable`, (blank) => {
        commitMessage.value = blank;
        fillCommitMessage(`fix: cascading markers`);
        expect(commitMessage.value).toBe(`fix: cascading markers`);
    });

    test(`a clear sweeps leftover whitespace out, so the placeholder can be seen again`, () => {
        commitMessage.value = ` `;
        clearFilledMessage();
        expect(commitMessage.value).toBe(``);
    });

    test(`editing a filled line makes it the user's, a later click leaves it alone`, () => {
        fillCommitMessage(`fix: cascading markers`);
        commitMessage.value = `fix: cascading markers in the tree`;
        fillCommitMessage(`feat: add chat tab icons`);
        expect(commitMessage.value).toBe(`fix: cascading markers in the tree`);
        clearFilledMessage();
        expect(commitMessage.value).toBe(`fix: cascading markers in the tree`);
    });

    // Must walk the same four states fillCommitMessage declines on, so the two can never disagree.
    test(`the box says whose it is`, () => {
        expect(boxIsYours.value).toBe(false);

        fillCommitMessage(`fix: cascading markers`);
        expect(boxIsYours.value).toBe(false);

        commitMessage.value = `fix: cascading markers in the tree`;
        expect(boxIsYours.value).toBe(true);

        commitMessage.value = `   `;
        expect(boxIsYours.value).toBe(false);
    });

    test(`clearing the box releases it back to the legend`, () => {
        fillCommitMessage(`fix: cascading markers`);
        commitMessage.value = ``;
        fillCommitMessage(`feat: add chat tab icons`);
        expect(commitMessage.value).toBe(`feat: add chat tab icons`);
    });
});

// The chip lights before the drafted sentence exists; these pin that the box still fills when it arrives late.
// A one-shot fill on the click alone would pass the suite above and fail every test here.
describe(`the box following a lit From chip`, () => {
    beforeEach(() => {
        commitMessage.value = ``;
    });

    test(`a message that arrives after the click still lands`, async () => {
        const message = ref<string | undefined>(undefined);
        followFilledMessage(message);

        message.value = `fix: cascading markers`;
        await nextTick();
        expect(commitMessage.value).toBe(`fix: cascading markers`);
    });

    test(`clicking off takes back the line that arrived late`, async () => {
        const message = ref<string | undefined>(undefined);
        followFilledMessage(message);

        message.value = `fix: cascading markers`;
        await nextTick();
        message.value = undefined;
        await nextTick();
        expect(commitMessage.value).toBe(``);
    });

    test(`a rewritten message replaces the line the same chip filed`, async () => {
        const message = ref<string | undefined>(`fix: cascading markers`);
        followFilledMessage(message);
        await nextTick();

        message.value = `fix: cascading markers and their counts`;
        await nextTick();
        expect(commitMessage.value).toBe(`fix: cascading markers and their counts`);
    });

    test(`a message that arrives late never overwrites what the user typed`, async () => {
        const message = ref<string | undefined>(undefined);
        followFilledMessage(message);

        commitMessage.value = `chore: my own subject`;
        message.value = `fix: cascading markers`;
        await nextTick();
        expect(commitMessage.value).toBe(`chore: my own subject`);
    });
});

// The ask must outlive the Changes panel, since it's destroyed by the Files|Changes|History switch before a
// landed message may finish drafting.
describe(`the ask to name a commit after a session`, () => {
    beforeEach(() => {
        commitMessage.value = ``;
        nameCommitAfter(undefined);
    });

    test(`is remembered independently of the panel that made it`, () => {
        nameCommitAfter(`agent-1`);
        expect(namedAfter.value).toBe(`agent-1`);
    });

    test(`is still answerable after the panel is gone`, () => {
        nameCommitAfter(`agent-1`);
        fillCommitMessage(`fix: cascading markers`);
        expect(commitMessage.value).toBe(`fix: cascading markers`);
    });

    test(`putting the chip out withdraws the ask and takes its line back`, () => {
        nameCommitAfter(`agent-1`);
        fillCommitMessage(`fix: cascading markers`);

        nameCommitAfter(undefined);
        expect(namedAfter.value).toBeUndefined();
        expect(commitMessage.value).toBe(``);
    });

    // Moving the ask is one gesture, not a withdrawal then a new ask; the last chip's line stays fillable.
    test(`moving the ask to another session leaves the box fillable`, () => {
        nameCommitAfter(`agent-1`);
        fillCommitMessage(`fix: cascading markers`);

        nameCommitAfter(`agent-2`);
        expect(namedAfter.value).toBe(`agent-2`);
        fillCommitMessage(`feat: second session`);
        expect(commitMessage.value).toBe(`feat: second session`);
    });

    test(`withdrawing leaves a message the user typed alone`, () => {
        nameCommitAfter(`agent-1`);
        commitMessage.value = `chore: my own subject`;

        nameCommitAfter(undefined);
        expect(commitMessage.value).toBe(`chore: my own subject`);
    });
});

// A reload is a fresh module instance reading what the last one left; these re-import the module rather than
// reaching into the live singleton.
describe(`the commit box after a reload`, () => {
    const load = async (): Promise<typeof import("./commitMessage")> => {
        vi.resetModules();
        return import("./commitMessage");
    };

    beforeEach(() => {
        stored.clear();
        active.sandboxId = `sandbox-1`;
    });

    // Resets for suites after this one, which run with no active sandbox.
    afterAll(() => {
        active.sandboxId = undefined;
    });

    test(`a line the legend filed is still the legend's, the next click replaces it`, async () => {
        const before = await load();
        before.fillCommitMessage(`fix: cascading markers`);
        await nextTick();

        const after = await load();
        expect(after.commitMessage.value).toBe(`fix: cascading markers`);
        after.fillCommitMessage(`feat: add chat tab icons`);
        expect(after.commitMessage.value).toBe(`feat: add chat tab icons`);
    });

    test(`and clicking off still takes it back`, async () => {
        const before = await load();
        before.fillCommitMessage(`fix: cascading markers`);
        await nextTick();

        const after = await load();
        after.clearFilledMessage();
        expect(after.commitMessage.value).toBe(``);
    });

    test(`a line the user typed comes back theirs`, async () => {
        const before = await load();
        before.commitMessage.value = `chore: my own subject`;
        await nextTick();

        const after = await load();
        after.fillCommitMessage(`fix: cascading markers`);
        expect(after.commitMessage.value).toBe(`chore: my own subject`);
    });

    // Editing a filled line ends its claim in the persisted record too, not just in memory.
    test(`a filled line the user edited comes back theirs`, async () => {
        const before = await load();
        before.fillCommitMessage(`fix: cascading markers`);
        before.commitMessage.value = `fix: cascading markers in the tree`;
        await nextTick();

        const after = await load();
        after.fillCommitMessage(`feat: add chat tab icons`);
        expect(after.commitMessage.value).toBe(`fix: cascading markers in the tree`);
    });

    test(`whitespace is never carried across a reload`, async () => {
        const before = await load();
        before.commitMessage.value = ` `;
        await nextTick();
        expect([...stored.keys()]).toEqual([]);

        const after = await load();
        expect(after.commitMessage.value).toBe(``);
        after.fillCommitMessage(`fix: cascading markers`);
        expect(after.commitMessage.value).toBe(`fix: cascading markers`);
    });

    test(`clearing a real message down to whitespace discards it`, async () => {
        const before = await load();
        before.commitMessage.value = `chore: my own subject`;
        await nextTick();
        before.commitMessage.value = `\n`;
        await nextTick();

        const after = await load();
        expect(after.commitMessage.value).toBe(``);
    });
});
