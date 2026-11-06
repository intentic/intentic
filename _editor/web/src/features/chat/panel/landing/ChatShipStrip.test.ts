// The strip's wiring, over the review and the push flow it reads: which commit the press asks for (this chat's origin,
// staged first, under the drafted message or the reader's own), that it remembers what it committed, and that the push
// goes through the one door every push does, from the shared tree. What it shows and when is shipStrip.test.ts's.
import "@intentic/testing/dom";
import type { RepoChanges } from "@intentic/sandbox-contract/schemas/git/git";
import { NO_ATTENTION } from "@intentic/sandbox-contract/models/agent-lanes";
import { type App, computed, createApp, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";
import type { FleetAgent } from "../../../../models/fleet/useAgents-fleet";

const repos = ref<RepoChanges[]>([]);
const committing = ref<string[]>([]);
const failures = ref(new Map<string, { action: string; detail: string }>());
// Answers as the commit run does: a passed commit leaves the branch one ahead and the session's files gone.
const commitRepos = jest.fn(async () => {
    repos.value = [repo({ unstaged: [], origins: {}, remote: { remote: `origin`, upstream: `origin/main`, ahead: 1, behind: 0 } })];
    return true;
});
jest.mock(`../../../../models/changes/useChanges`, () => ({
    COMMIT_SCOPE: `commit`,
    useChanges: () => ({ repos, committing, failures, commitRepos, actionBusy: ref(false), loaded: ref(true) }),
}));
const askSync = jest.fn();
jest.mock(`../../../../models/changes/usePushFlow`, () => ({
    usePushFlow: () => ({
        running: ref(false),
        pending: ref(undefined),
        pushed: ref(undefined),
        question: ref(undefined),
        held: ref(undefined),
        askSync,
        reopen: jest.fn(),
    }),
}));
const openChanges = jest.fn();
jest.mock(`../../../../models/changes/openChanges`, () => ({ openChanges }));

const { default: ChatShipStrip } = await import("./ChatShipStrip.vue");
const { SHARED_SCOPE } = await import("../../../../app/workspaceScope");
const { forgetSessionCommits, sessionCommitsOf } = await import("../../../../models/changes/sessionCommits");

const ID = `brave-otter`;

function repo(over: Partial<RepoChanges> = {}): RepoChanges {
    return {
        repo: `root`,
        conflicted: [],
        staged: [],
        unstaged: [
            { path: `src/a.ts`, status: `modified` },
            { path: `notes.md`, status: `modified` },
        ],
        origins: { "src/a.ts": [ID] },
        remote: { remote: `origin`, upstream: `origin/main`, ahead: 0, behind: 0 },
        ...over,
    };
}

const agent = (over: Partial<FleetAgent> = {}): FleetAgent => ({
    id: ID,
    title: `Ship from the chat`,
    status: `landed`,
    provider: `claude`,
    harness: `native`,
    updatedAt: 0,
    attention: NO_ATTENTION,
    open: true,
    unread: false,
    unsent: false,
    landedMessage: { subject: `Add commit and push to the chat's strip` },
    ...over,
});

let app: App | undefined;
const mount = (card: FleetAgent): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    const held = computed(() => card);
    app = createApp({ render: () => h(ChatShipStrip, { agent: held.value }) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(element);
    return element;
};

const button = (element: HTMLElement, label: string): HTMLButtonElement | undefined =>
    [...element.querySelectorAll(`button`)].find((control) => control.textContent?.includes(label) === true);

beforeEach(() => {
    repos.value = [repo()];
    committing.value = [];
    failures.value = new Map();
    commitRepos.mockClear();
    askSync.mockClear();
    forgetSessionCommits(ID);
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`commits this chat's files alone, staged first, under the message drafted when it landed`, async () => {
    const element = mount(agent());
    expect(element.textContent).toContain(`Add commit and push to the chat's strip`);

    button(element, `Commit`)?.click();
    await nextTick();

    expect(commitRepos).toHaveBeenCalledWith([{ repo: `root`, scope: { origin: ID } }], `Add commit and push to the chat's strip`, true, {
        label: `Commit`,
        count: 1,
    });
    // Remembered, so the strip that follows offers the push of what it just recorded.
    await nextTick();
    expect(sessionCommitsOf(ID)).toEqual({ root: 1 });
    expect(element.textContent).toContain(`1 commit to push`);
});

it(`asks the reader for the message when none was written, and commits theirs`, async () => {
    const element = mount(agent({ landedMessage: undefined, landedMessageDraft: { startedAt: 0, steps: [], outcome: `failed`, reason: `every model refused` } }));
    const commit = button(element, `Commit`);
    expect(commit?.disabled).toBe(true);

    const input = element.querySelector<HTMLInputElement>(`input[data-ship-message]`)!;
    input.value = `Ship from the chat`;
    input.dispatchEvent(new Event(`input`));
    await nextTick();
    expect(commit?.disabled).toBe(false);

    commit?.click();
    await nextTick();
    expect(commitRepos).toHaveBeenCalledWith([{ repo: `root`, scope: { origin: ID } }], `Ship from the chat`, true, expect.anything());
});

it(`waits on a message still being written rather than committing without one`, () => {
    const element = mount(agent({ landedMessage: undefined, landedMessageDraft: { startedAt: 0, steps: [] } }));
    expect(element.textContent).toContain(`Writing the commit message`);
    expect(button(element, `Commit`)?.disabled).toBe(true);
    expect(element.querySelector(`input`)).toBeNull();
});

it(`sends a commit that would take another chat's lines to the Changes panel`, () => {
    repos.value = [repo({ origins: { "src/a.ts": [`quiet-heron`, ID] } })];
    const element = mount(agent());
    expect(element.textContent).toContain(`Another chat landed some of the same files.`);
    expect(button(element, `Commit`)).toBeUndefined();

    button(element, `Changes`)?.click();
    expect(openChanges).toHaveBeenCalledTimes(1);
});

it(`pushes what it committed through the push flow, from the shared tree`, async () => {
    const element = mount(agent());
    button(element, `Commit`)?.click();
    await nextTick();
    await nextTick();

    button(element, `Push`)?.click();
    expect(askSync).toHaveBeenCalledWith(`Push`, `1 commit`, [{ repo: `root`, pull: false, push: true }], SHARED_SCOPE);
});
