// jsdom because the subject is which sentence the column prints. The panel used to decide that from "a read is in
// flight", and a workspace being written to (a test run, a build) makes the daemon re-read this list about once a
// second — so a clean tree blinked between its answer and its waiting line for as long as the writes lasted. Only a
// render can tell those two sentences apart.
import "@intentic/testing/dom";
import type { AgentSummary, GitChanges, RepoChanges } from "@intentic/sandbox-contract";
import { IconStub } from "@intentic/ui/testing";
import { VueQueryPlugin } from "@tanstack/vue-query";
import { type App, createApp, h, nextTick } from "vue";
import { queryClient } from "../../../lib/queryPersistence";
import { router } from "../../../router";
import { signalConnection } from "../../../client/sandbox/useSandbox";
import { registry } from "../../agents/fleet/useAgents-registry";
import { changesKey } from "./useChanges";
import * as actualSandboxRpc from "../../../client/sandbox/sandboxRpc";
import { fakeSandboxRpc } from "../../../testing/sandboxRpcFake";

// Every daemon read in the panel's graph goes through the typed client. `git.changes` is handed out a request at a
// time, so a read can be held open while the assertions run; every other procedure throws naming itself, since no
// other read decides anything here.
const held: ((response: GitChanges) => void)[] = [];
const changes = jest.fn(() => new Promise<GitChanges>((resolve) => held.push(resolve)));
const commit = jest.fn(async (_input: unknown) => ({ committed: true, sha: `abc1234`.padEnd(40, `0`) }));
// The commit page's recent commits; nothing here reads them.
const log = jest.fn(async (input: { repo: string }) => ({ repo: input.repo, commits: [], hasMore: false }));
// Snapshotted before the mock replaces the module: a namespace is a live binding, so spreading it afterwards would
// spread the stand-in.
const realSandboxRpc = { ...actualSandboxRpc };
jest.mock("../../../client/sandbox/sandboxRpc", () => ({ ...realSandboxRpc, sandboxRpc: fakeSandboxRpc({ git: { changes, commit, log } }) }));

const { default: ReviewPanel } = await import("./ReviewPanel.vue");
const { default: CommitPage } = await import("./CommitPage.vue");
const { commitMessage, nameCommitAfter } = await import("./commitMessage");

let app: App | undefined;

// The phone's arrangement by default: the list with its chips on top and the composer docked under it. `page` is the
// desktop's: the list beside the commit page, which holds the chips and the composer.
const mount = async ({ page = false }: { readonly page?: boolean } = {}): Promise<HTMLElement> => {
    // Reads are gated on a live daemon, and the read is the whole subject here, so the connection is stood up for
    // real rather than seeding an answer behind the panel's back.
    signalConnection({ kind: `switched`, lastKnownOnline: true });
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ setup: () => () => (page ? h(`div`, [h(ReviewPanel), h(CommitPage)]) : h(ReviewPanel, { docked: true })) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.use(router);
    app.use(VueQueryPlugin, { queryClient });
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

// The chip lit for what Commit records.
const pickedChip = (el: HTMLElement): Element | null => el.querySelector(`[data-scope-chip][aria-pressed="true"]`);
const chipNamed = (el: HTMLElement, text: string): HTMLButtonElement | undefined =>
    [...el.querySelectorAll<HTMLButtonElement>(`[data-scope-chip]`)].find((chip) => chip.textContent?.includes(text));

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    queryClient.clear();
    held.length = 0;
    registry.value = [];
    commit.mockClear();
    nameCommitAfter(undefined);
    commitMessage.value = ``;
});

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

// A finished conversation whose merged work is waiting in the tree, with the sentence it drafted for it.
const landed = (id: string, title: string, subject?: string): AgentSummary => ({
    id,
    status: `idle`,
    title,
    provider: `claude`,
    harness: `native`,
    updatedAt: 0,
    attention: { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false },
    ...(subject === undefined ? {} : { landedMessage: { subject } }),
});

// One repo: a file the owner staged by hand, and two files a conversation landed.
const mixedTree = (): GitChanges => ({
    repos: [
        {
            repo: `root`,
            branch: `main`,
            conflicted: [],
            staged: [{ path: `mine.ts`, status: `modified`, additions: 1, deletions: 0 }],
            unstaged: [
                { path: `turn-sandbox.ts`, status: `modified`, additions: 4, deletions: 1 },
                { path: `namespace-holder.test.ts`, status: `modified`, additions: 1, deletions: 1 },
            ],
            origins: { "turn-sandbox.ts": [`a1`], "namespace-holder.test.ts": [`a1`] },
        },
    ],
});

const rowOf = (el: HTMLElement, name: string): HTMLElement | undefined =>
    [...el.querySelectorAll<HTMLElement>(`.group\\/file`)].find((row) => row.textContent?.includes(name));

// The bug this layout closed: with a session picked, Commit used to record whatever was staged, while the filter hid
// the staged rows and the box held that session's sentence. A session's commit now records its files alone, and every
// row stays on screen, the ones it leaves out dimmed.
it(`commits one conversation's files alone, leaving a hand-staged file staged and on screen`, async () => {
    registry.value = [landed(`a1`, `intentic CI`, `Fix sandbox turn cleanup`)];
    nameCommitAfter(`a1`);
    const el = await mount({ page: true });
    await answer(mixedTree());

    expect(pickedChip(el)?.textContent).toContain(`intentic CI`);
    expect(rowOf(el, `mine.ts`)?.hasAttribute(`data-out-of-scope`)).toBe(true);
    expect(rowOf(el, `turn-sandbox.ts`)?.hasAttribute(`data-out-of-scope`)).toBe(false);
    // The button counts what it records, and the line beside it says what the press does to the index on the way.
    expect(el.querySelector(`[data-commit]`)?.textContent).toContain(`Commit 2 files`);
    expect(el.textContent).toContain(`other staged files stay out`);
    // The drafted sentence reached the box without a second click.
    expect(el.querySelector<HTMLTextAreaElement>(`[data-commit-message]`)?.value).toBe(`Fix sandbox turn cleanup`);

    el.querySelector<HTMLButtonElement>(`[data-commit]`)?.click();
    await settle();
    expect(commit).toHaveBeenCalledWith({ repo: `root`, message: `Fix sandbox turn cleanup`, stage: { scope: { origin: `a1` } }, only: true });
});

// With nothing named, a staged index is git's own selection and wins; the session's rows dim instead.
it(`opens on what is staged when something is, recording the index as it stands`, async () => {
    registry.value = [landed(`a1`, `intentic CI`)];
    const el = await mount();
    await answer(mixedTree());

    expect(pickedChip(el)?.textContent).toContain(`Staged`);
    expect(rowOf(el, `mine.ts`)?.hasAttribute(`data-out-of-scope`)).toBe(false);
    expect(rowOf(el, `turn-sandbox.ts`)?.hasAttribute(`data-out-of-scope`)).toBe(true);

    commitMessage.value = `chore: mine`;
    await nextTick();
    el.querySelector<HTMLButtonElement>(`[data-commit]`)?.click();
    await settle();
    expect(commit).toHaveBeenCalledWith({ repo: `root`, message: `chore: mine` });
});

// The screenshot's case: one session's work is all that's here, so the dock opens on it, and the draft's progress sits
// on one line inside the field rather than a growing list above the button.
it(`opens on the one conversation whose work is all that is here, its draft on one line`, async () => {
    registry.value = [
        {
            ...landed(`a1`, `intentic CI`),
            landedMessageDraft: {
                startedAt: 0,
                steps: [
                    {
                        provider: `cursor`,
                        model: `composer-2.5`,
                        status: `refused`,
                        at: 0,
                        ms: 20_000,
                        reason: `the model did not answer within 20s`,
                    },
                    { provider: `openai`, model: `gpt-6-luna`, status: `asking`, at: Date.now() },
                ],
            },
        },
    ];
    const el = await mount();
    const tree = mixedTree();
    await answer({ repos: tree.repos.map((repo) => ({ ...repo, staged: [] })) });

    expect(pickedChip(el)?.textContent).toContain(`intentic CI`);
    const line = el.querySelector(`[data-draft-line]`);
    expect(line?.textContent).toContain(`Writing message…`);
    expect(line?.textContent).toContain(`1 failed`);
    // No message yet, so Commit waits for one.
    expect(el.querySelector<HTMLButtonElement>(`[data-commit]`)?.disabled).toBe(true);
});

// Committing everything leaves the repo clean, and the scan leaves out a clean repo with nothing to sync, so the
// receipt can't read the repo any more. A local repo's commit is still the user's to take back; a repo with a remote
// that no longer lists it has nothing ahead, so the remote already holds the commit.
const committedClean = async (remote: RepoChanges[`remote`]): Promise<HTMLElement> => {
    const el = await mount();
    await answer({
        repos: [
            {
                repo: `root`,
                branch: `main`,
                conflicted: [],
                staged: [],
                unstaged: [{ path: `notes.md`, status: `modified`, additions: 1, deletions: 0 }],
                ...(remote === undefined ? {} : { remote }),
            },
        ],
    });
    commitMessage.value = `docs: notes`;
    await nextTick();
    el.querySelector<HTMLButtonElement>(`[data-commit]`)?.click();
    await settle();
    expect(el.querySelector(`[data-commit-receipt]`)?.textContent).toContain(`Committed abc1234`);
    return el;
};

it(`offers Undo for a commit that left a local repo clean`, async () => {
    const el = await committedClean(undefined);
    expect(el.querySelector(`[data-commit-undo]`)).not.toBeNull();
});

it(`offers no Undo once a remote holds the commit`, async () => {
    const el = await committedClean({ remote: `origin`, branch: `main`, upstream: `origin/main`, ahead: 0, behind: 0 });
    expect(el.querySelector(`[data-commit-undo]`)).toBeNull();
});

// One click picks what to commit, and a second on the same chip lets go of it, back to what the box opened on.
it(`picks a session in one click and lets go of it on the next`, async () => {
    registry.value = [landed(`a1`, `intentic CI`, `Fix sandbox turn cleanup`)];
    const el = await mount({ page: true });
    await answer(mixedTree());
    expect(pickedChip(el)?.textContent).toContain(`Staged`);

    chipNamed(el, `intentic CI`)?.click();
    await nextTick();
    expect(pickedChip(el)?.textContent).toContain(`intentic CI`);
    expect(rowOf(el, `mine.ts`)?.hasAttribute(`data-out-of-scope`)).toBe(true);

    chipNamed(el, `intentic CI`)?.click();
    await nextTick();
    expect(pickedChip(el)?.textContent).toContain(`Staged`);
    expect(rowOf(el, `mine.ts`)?.hasAttribute(`data-out-of-scope`)).toBe(false);
});
