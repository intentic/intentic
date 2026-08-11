import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { nextTick, ref } from "vue";

/* The draft store is a module singleton whose only edge is the active sandbox (it keys the persisted draft), and
 * it reads that id when it is IMPORTED — so both of these have to exist before the imports below, which is what
 * `vi.hoisted` is for. A mock factory closing over an ordinary `let` reads it in its temporal dead zone.
 *
 * `active.sandboxId` undefined switches every localStorage path off, which is what the first suite wants — its
 * rules are about who owns the box, not where it is kept. The reload suite sets a real id to switch them on.
 * `stored` is storage as the browser's minus the browser: enough for one instance to persist a record and the
 * next to read it back, which is the whole of what a reload is here. */
const { active, stored } = vi.hoisted(() => {
    const state = { active: { sandboxId: undefined as string | undefined }, stored: new Map<string, string>() };
    return state;
});

vi.mock("../sandbox/useSandbox", async () => {
    const { ref } = await import("vue");
    return { useSandbox: () => ({ activeSandboxId: ref<string | undefined>(active.sandboxId) }) };
});

vi.stubGlobal(`localStorage`, {
    getItem: (key: string): string | null => stored.get(key) ?? null,
    setItem: (key: string, value: string): void => void stored.set(key, value),
    removeItem: (key: string): void => void stored.delete(key),
});

import { clearFilledMessage, commitMessage, fillCommitMessage, followFilledMessage } from "./commitMessage";

describe(`the commit box`, () => {
    beforeEach(() => {
        commitMessage.value = ``;
    });

    test(`starts empty — nothing fills it on its own`, () => {
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

    // The whole reason the fill records what it wrote: everything below is a box the user has made theirs.
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

    test(`editing a filled line makes it the user's — a later click leaves it alone`, () => {
        fillCommitMessage(`fix: cascading markers`);
        commitMessage.value = `fix: cascading markers in the tree`;
        fillCommitMessage(`feat: add chat tab icons`);
        expect(commitMessage.value).toBe(`fix: cascading markers in the tree`);
        clearFilledMessage();
        expect(commitMessage.value).toBe(`fix: cascading markers in the tree`);
    });

    // What a successful commit does. The box is empty again, so the legend is free to name the next one.
    test(`clearing the box releases it back to the legend`, () => {
        fillCommitMessage(`fix: cascading markers`);
        commitMessage.value = ``;
        fillCommitMessage(`feat: add chat tab icons`);
        expect(commitMessage.value).toBe(`feat: add chat tab icons`);
    });
});

/* The chip is lit BEFORE the sentence about that work exists — the drafting starts at the land and answers
 * seconds later — so what these pin is that the box is still listening when it does. A one-shot fill on the
 * click passes every test above and none of these. */
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

    // A second land rewrites the sentence about the same session — the chip's own line, replaced by the chip.
    test(`a rewritten message replaces the line the same chip filed`, async () => {
        const message = ref<string | undefined>(`fix: cascading markers`);
        followFilledMessage(message);
        await nextTick();

        message.value = `fix: cascading markers and their counts`;
        await nextTick();
        expect(commitMessage.value).toBe(`fix: cascading markers and their counts`);
    });

    // The box the user typed in while waiting is still theirs — arriving late buys the fill nothing.
    test(`a message that arrives late never overwrites what the user typed`, async () => {
        const message = ref<string | undefined>(undefined);
        followFilledMessage(message);

        commitMessage.value = `chore: my own subject`;
        message.value = `fix: cascading markers`;
        await nextTick();
        expect(commitMessage.value).toBe(`chore: my own subject`);
    });
});

/* A RELOAD IS A FRESH MODULE INSTANCE reading what the last one left, so these re-import the singleton rather
 * than reaching into it — nothing else can say what the box comes back HOLDING, and coming back holding a line
 * no click could replace is the bug this pins. */
describe(`the commit box after a reload`, () => {
    const load = async (): Promise<typeof import("./commitMessage")> => {
        vi.resetModules();
        return import("./commitMessage");
    };

    beforeEach(() => {
        stored.clear();
        active.sandboxId = `sandbox-1`;
    });

    // The first suite runs against no sandbox at all; leave it that way for anything that follows.
    afterAll(() => {
        active.sandboxId = undefined;
    });

    test(`a line the legend filed is still the legend's — the next click replaces it`, async () => {
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

    // The other half, and the one that must not regress: a reload cannot turn something typed into something a
    // click may overwrite.
    test(`a line the user typed comes back theirs`, async () => {
        const before = await load();
        before.commitMessage.value = `chore: my own subject`;
        await nextTick();

        const after = await load();
        after.fillCommitMessage(`fix: cascading markers`);
        expect(after.commitMessage.value).toBe(`chore: my own subject`);
    });

    // An edited fill is a typed line, and the edit is what ends the claim — including the record on disk.
    test(`a filled line the user edited comes back theirs`, async () => {
        const before = await load();
        before.fillCommitMessage(`fix: cascading markers`);
        before.commitMessage.value = `fix: cascading markers in the tree`;
        await nextTick();

        const after = await load();
        after.fillCommitMessage(`feat: add chat tab icons`);
        expect(after.commitMessage.value).toBe(`fix: cascading markers in the tree`);
    });
});
