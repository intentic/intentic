import { beforeEach, describe, expect, test, vi } from "vitest";

// The draft store is a module singleton whose only edge is the active sandbox (it keys the persisted draft).
// Held at `undefined` here, which is also what switches every localStorage path off — the rules under test are
// about who owns the box, not about where it is kept.
vi.mock("../sandbox/useSandbox", async () => {
    const { ref } = await import("vue");
    return { useSandbox: () => ({ activeSandboxId: ref<string | undefined>(undefined) }) };
});

import { clearFilledMessage, commitMessage, fillCommitMessage } from "./commitMessage";

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
