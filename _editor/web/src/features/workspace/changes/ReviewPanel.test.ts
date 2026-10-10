// jsdom because the subject is which sentence the column prints. The panel used to decide that from "a read is in
// flight", and a workspace being written to (a test run, a build) makes the daemon re-read this list about once a
// second — so a clean tree blinked between its answer and its waiting line for as long as the writes lasted. Only a
// render can tell those two sentences apart.
import "@intentic/testing/dom";
import type { AgentSummary, GitChanges } from "@intentic/sandbox-contract";
import { IconStub } from "@intentic/ui/testing";
import { VueQueryPlugin } from "@tanstack/vue-query";
import PrimeVue from "primevue/config";
import { type App, createApp, h, nextTick } from "vue";
import { queryClient } from "../../../lib/queryPersistence";
import { router } from "../../../router";
import { signalConnection } from "../../../client/sandbox/useSandbox";
import { registry } from "../../agents/fleet/useAgents-registry";
import { changesKey } from "./useChanges";
import { commitMessage, nameCommitAfter } from "./commit/commitMessage";
import * as actualSandboxRpc from "../../../client/sandbox/sandboxRpc";
import { fakeSandboxRpc } from "../../../testing/sandboxRpcFake";

// Every daemon read in the panel's graph goes through the typed client. `git.changes` is handed out a request at a
// time, so a read can be held open while the assertions run; every other procedure throws naming itself, since no
// other read decides anything here.
const held: ((response: GitChanges) => void)[] = [];
const changes = jest.fn(() => new Promise<GitChanges>((resolve) => held.push(resolve)));
// The index moves a FROM chip makes; answered at once, since what matters is which scope each one names.
const stage = jest.fn(() => Promise.resolve({ ok: true as const }));
const unstage = jest.fn(() => Promise.resolve({ ok: true as const }));
const discard = jest.fn(() => Promise.resolve({ ok: true as const }));
const commit = jest.fn((): Promise<{ committed: boolean }> => Promise.resolve({ committed: true }));
// Snapshotted before the mock replaces the module: a namespace is a live binding, so spreading it afterwards would
// spread the stand-in.
const realSandboxRpc = { ...actualSandboxRpc };
jest.mock("../../../client/sandbox/sandboxRpc", () => ({ ...realSandboxRpc, sandboxRpc: fakeSandboxRpc({ git: { changes, stage, unstage, discard, commit } }) }));

const { default: ReviewPanel } = await import("./ReviewPanel.vue");

let app: App | undefined;

const mount = async (): Promise<HTMLElement> => {
    // Reads are gated on a live daemon, and the read is the whole subject here, so the connection is stood up for
    // real rather than seeding an answer behind the panel's back.
    signalConnection({ kind: `switched`, lastKnownOnline: true });
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ setup: () => () => h(ReviewPanel) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.directive(`action`, { mounted: (node: HTMLElement, binding) => node.addEventListener(`click`, () => binding.value()) });
    app.use(router);
    app.use(VueQueryPlugin, { queryClient });
    app.use(PrimeVue);
    app.mount(el);
    await nextTick();
    return el;
};

// Lets the query layer's own promise chain run out before the DOM is read.
const settle = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
};

// Settles the oldest held read, then lets the render catch up.
const answer = async (response: GitChanges): Promise<void> => {
    held.shift()?.(response);
    await settle();
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    queryClient.clear();
    held.length = 0;
    registry.value = [];
    stage.mockClear();
    unstage.mockClear();
    discard.mockClear();
    commit.mockClear();
    // A lit chip's ask lives at module scope, so one test's click would light the next test's chip.
    nameCommitAfter(undefined);
    commitMessage.value = ``;
});

const buttonNamed = (el: HTMLElement, text: string): HTMLButtonElement | undefined =>
    [...el.querySelectorAll<HTMLButtonElement>(`button`)].find((button) => button.textContent?.includes(text));

// One roster entry, cut to what the landing line reads: a conversation's status and what to call it.
const landing = (title: string): AgentSummary => ({
    id: `a1`,
    status: `landing`,
    title,
    provider: `claude`,
    harness: `native`,
    updatedAt: 0,
    attention: { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false },
});

it(`waits only for the first answer, then keeps it while the daemon is asked again`, async () => {
    const el = await mount();
    expect(el.textContent).toContain(`Loading changes…`);

    await answer({ repos: [] });
    expect(el.textContent).toContain(`No uncommitted changes.`);
    expect(el.textContent).not.toContain(`Loading changes…`);

    // Exactly what the file watcher does while a build or a test run writes into the workspace (systemEvents).
    void queryClient.invalidateQueries({ queryKey: changesKey() });
    await settle();

    // A read really is in flight — the point is that the answer on screen survives it.
    expect(held).toHaveLength(1);
    expect(el.textContent).toContain(`No uncommitted changes.`);
    expect(el.textContent).not.toContain(`Loading changes…`);

    await answer({ repos: [] });
    expect(el.textContent).toContain(`No uncommitted changes.`);
});

// The complaint this answers: press Land on the board, switch here, and read a flat denial that anything is happening
// for as long as the patch takes. The list is deliberately the tree from before the land — the review doesn't rescan
// mid-land — so the one thing it may not do is keep claiming the tree is clean.
it(`says what is being carried in instead of denying there is anything`, async () => {
    const el = await mount();
    await answer({ repos: [] });
    expect(el.textContent).toContain(`No uncommitted changes.`);

    registry.value = [landing(`Rewrite the parser`)];
    await nextTick();
    expect(el.textContent).toContain(`Landing Rewrite the parser…`);
    expect(el.textContent).not.toContain(`No uncommitted changes.`);

    // And gets out of the way the moment the tree can speak for itself.
    registry.value = [];
    await nextTick();
    expect(el.textContent).not.toContain(`Landing Rewrite the parser…`);
    expect(el.textContent).toContain(`No uncommitted changes.`);
});

// The expensive half of the same thing. Opening this panel is itself a read (nothing is ever fresh here), so pressing
// Land and switching straight to the workspace used to scan every repo against a tree the patch was still being
// written into — an answer thrown away, taking the git subprocesses the land was queued on with it.
it(`asks the daemon nothing while a land is applying, and asks once it settles`, async () => {
    registry.value = [landing(`Rewrite the parser`)];
    const el = await mount();
    await settle();

    expect(held).toHaveLength(0);
    expect(el.textContent).toContain(`Landing Rewrite the parser…`);

    registry.value = [];
    await settle();
    expect(held).toHaveLength(1);
});

// The bug this closed: with a session's chip lit and the owner's own file staged, Commit records the whole index (git
// has no other commit), but the filter hid the owner's staged row, so the commit took a file nobody could see. Staged
// is what Commit records, so the filter never narrows it.
it(`keeps every staged file on screen under a session's filter, since Commit records them all`, async () => {
    const el = await mount();
    await answer({
        repos: [
            {
                repo: `root`,
                branch: `main`,
                conflicted: [],
                staged: [{ path: `mine.ts`, status: `modified` }],
                unstaged: [
                    { path: `agent.ts`, status: `modified` },
                    { path: `also-mine.ts`, status: `modified` },
                ],
                origins: { "agent.ts": [`a1`] },
            },
        ],
        originAgents: { a1: { title: `Fix sandbox turn cleanup`, provider: `claude` } },
    });
    expect(el.textContent).toContain(`also-mine.ts`);

    [...el.querySelectorAll<HTMLButtonElement>(`button`)].find((button) => button.textContent?.includes(`Fix sandbox turn cleanup`))?.click();
    await settle();

    // The filter hides the owner's unstaged edit, and leaves the staged one Commit would take.
    expect(el.textContent).not.toContain(`also-mine.ts`);
    expect(el.textContent).toContain(`agent.ts`);
    expect(el.textContent).toContain(`mine.ts`);
});

// The complaint this answers: a lit chip only filtered the list, while Commit quietly staged that session's files and
// committed them, files the list still drew under Unstaged. With anything else staged, the chip named the commit after
// the session and the commit took none of its files. A chip is now the "+" on its session's work.
it(`stages a session's work when its chip is lit, and unstages it when the chip is cleared`, async () => {
    const el = await mount();
    const unstagedTree = (staged: boolean): GitChanges => ({
        repos: [
            {
                repo: `root`,
                branch: `main`,
                conflicted: [],
                staged: staged ? [{ path: `agent.ts`, status: `modified` }] : [],
                unstaged: [...(staged ? [] : [{ path: `agent.ts`, status: `modified` as const }]), { path: `mine.ts`, status: `modified` }],
                origins: { "agent.ts": [`a1`] },
            },
        ],
        originAgents: { a1: { title: `Fix sandbox turn cleanup`, provider: `claude` } },
    });
    await answer(unstagedTree(false));
    // Nothing staged and no chip lit: the one-move stage-and-commit, over a list with every file on screen.
    expect(buttonNamed(el, `Commit all`)).toBeInstanceOf(HTMLButtonElement);

    buttonNamed(el, `Fix sandbox turn cleanup`)?.click();
    await settle();
    expect(stage).toHaveBeenCalledWith({ repo: `root`, chip: `a1` });
    expect(unstage).not.toHaveBeenCalled();
    // Under a lit chip Commit records the index, never a stage-first over rows the filter hides.
    expect(buttonNamed(el, `Commit all`)).toBeUndefined();

    await answer(unstagedTree(true));
    // The staged count rides on the press itself; there's no "N staged" readout beside it any more.
    expect(buttonNamed(el, `Commit`)?.textContent?.replace(/\s+/g, ` `).trim()).toBe(`Commit 1`);
    expect(el.textContent).not.toMatch(/\d+ staged/);
    buttonNamed(el, `Fix sandbox turn cleanup`)?.click();
    await settle();
    // Cleared by name, not by scope: the daemon writes back what that chip replaced and nothing else, so a file the
    // owner staged by hand before lighting it stays staged (chip-staging.integration.test.ts asserts git's side).
    expect(unstage).toHaveBeenCalledWith({ repo: `root`, chip: `a1` });
    expect(stage).toHaveBeenCalledTimes(1);
});

const buttons = (): HTMLButtonElement[] => [...document.body.querySelectorAll<HTMLButtonElement>(`button`)];
const chip = (text: string): HTMLButtonElement | undefined =>
    buttons().find((button) => button.getAttribute(`aria-pressed`) !== null && (button.textContent ?? ``).toLowerCase().includes(text.toLowerCase()));
const TITLE = `Fix sandbox turn cleanup`;

// Switching chips swaps one for the other in one move per repo, the clear first, and each by the chip's own name.
it(`moving from one chip to another clears the first by name before lighting the second`, async () => {
    await mount();
    await answer({
        repos: [
            {
                repo: `root`,
                branch: `main`,
                conflicted: [],
                staged: [{ path: `mine.ts`, status: `modified` }],
                unstaged: [
                    { path: `agent.ts`, status: `modified` },
                    { path: `also-mine.ts`, status: `modified` },
                ],
                origins: { "agent.ts": [`a1`] },
            },
        ],
        originAgents: { a1: { title: TITLE, provider: `claude` } },
    });
    chip(`You`)?.click();
    await settle();
    expect(stage).toHaveBeenLastCalledWith({ repo: `root`, chip: `yours` });
    chip(TITLE)?.click();
    await settle();
    expect(unstage).toHaveBeenCalledWith({ repo: `root`, chip: `yours` });
    expect(stage).toHaveBeenLastCalledWith({ repo: `root`, chip: `a1` });
    expect(unstage.mock.invocationCallOrder[0]).toBeLessThan(stage.mock.invocationCallOrder[1]!);
    // No scope that would sweep the owner's hand-staged mine.ts out with the chip's own staging.
    expect(unstage).not.toHaveBeenCalledWith(expect.objectContaining({ scope: expect.anything() }));
});

// The owner renamed the agent's util.ts to helpers.ts and kept working in it. The row is the agent's (it came from a
// landed path), so the count, the question and the scope the daemon resolves all say so, and the question names
// helpers.ts as the file that leaves the disk.
it(`a repo discard under an agent's chip names every file its scope takes, a rename's new leg among those deleted`, async () => {
    await mount();
    await answer({
        repos: [
            {
                repo: `root`,
                branch: `main`,
                conflicted: [],
                staged: [
                    { path: `helpers.ts`, from: `util.ts`, status: `renamed` },
                    { path: `other.ts`, status: `modified` },
                ],
                unstaged: [{ path: `mine.ts`, status: `modified` }],
                origins: { "util.ts": [`a1`], "other.ts": [`a1`] },
            },
        ],
        originAgents: { a1: { title: TITLE, provider: `claude` } },
    });
    expect(chip(`You`)?.textContent?.replace(/\s+/g, ` `).trim()).toBe(`you1`);
    expect(chip(TITLE)?.textContent).toContain(`2`);

    chip(TITLE)?.click();
    await settle();
    buttons()
        .find((button) => button.getAttribute(`aria-label`) === `Discard all changes in this repo`)
        ?.click();
    await settle();

    const text = document.body.textContent ?? ``;
    // helpers.ts, util.ts and other.ts: what `{ origin: "a1" }` resolves to daemon-side.
    expect(text).toContain(`Discard 3 files from ${TITLE} in root?`);
    expect(text).toContain(`2 files return to their last committed state.`);
    expect(text).toMatch(/1 untracked file[^]*helpers\.ts/);
    expect(text).not.toContain(`mine.ts`);

    buttons()
        .find((button) => button.textContent?.trim() === `Discard`)
        ?.click();
    await settle();
    expect(discard).toHaveBeenCalledWith({ repo: `root`, scope: { origin: `a1` } });
});

// The chip row used to be drawn only while an agent had files, so a lit "You" outlived its own chip once the last
// agent's work left the tree, and held "Commit all" off until the panel was remounted.
it(`a lit You chip stays on screen after the last agent's work leaves, so clearing it brings Commit all back`, async () => {
    const el = await mount();
    await answer({
        repos: [
            {
                repo: `root`,
                branch: `main`,
                conflicted: [],
                staged: [],
                unstaged: [
                    { path: `agent.ts`, status: `modified` },
                    { path: `mine.ts`, status: `modified` },
                ],
                origins: { "agent.ts": [`a1`] },
            },
        ],
        originAgents: { a1: { title: TITLE, provider: `claude` } },
    });
    chip(`You`)?.click();
    await settle();
    await answer({ repos: [{ repo: `root`, branch: `main`, conflicted: [], staged: [], unstaged: [{ path: `mine.ts`, status: `modified` }] }] });

    expect(chip(`You`)?.getAttribute(`aria-pressed`)).toBe(`true`);
    expect(buttonNamed(el, `Commit all`)).toBeUndefined();
    chip(`You`)?.click();
    await settle();
    expect(unstage).toHaveBeenCalledWith({ repo: `root`, chip: `yours` });
    expect(buttonNamed(el, `Commit all`)).toBeInstanceOf(HTMLButtonElement);
});

// "Commit all" over nothing but scratch stages nothing, and git records nothing; the message the owner typed stays.
it(`keeps the typed message and says so when a commit recorded nothing`, async () => {
    const el = await mount();
    const scratchOnly = {
        repo: `root`,
        branch: `main`,
        conflicted: [],
        staged: [],
        unstaged: [{ path: `debug.log`, status: `added` as const }],
        scratch: [{ path: `debug.log`, reason: `byproduct` as const }],
    };
    await answer({ repos: [scratchOnly] });
    commitMessage.value = `chore: keep this`;
    await settle();
    // As the daemon answers it: nothing recorded, and the repo's rows as they still stand.
    commit.mockResolvedValueOnce({ committed: false, changes: scratchOnly } as { committed: boolean });
    buttonNamed(el, `Commit all`)?.click();
    await settle();
    expect(commit).toHaveBeenCalledWith({ repo: `root`, message: `chore: keep this`, stage: {} });
    expect(commitMessage.value).toBe(`chore: keep this`);
    expect(el.textContent).toContain(`Nothing to commit.`);
});
