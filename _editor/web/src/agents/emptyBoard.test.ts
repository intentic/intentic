// @vitest-environment jsdom
//
// THE EMPTY BOARD, MOUNTED. Out of setup the desktop lands on the workspace, and this board is the first
// screen most new users deliberately open, and on a box with nothing on it the things that make it work are
// easy to break silently: that it asks for a task rather than for a sign-in, whatever this sandbox can send
// with, that an empty workspace is offered the one task needing no code and none of the ones that need some,
// and that a starter fills the chat's composer rather than dispatching an agent. All are asserted against the
// real component.
import { TRIAL_PROVIDER } from "@intentic/sandbox-contract";
import { VueQueryPlugin } from "@tanstack/vue-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick } from "vue";
import { accountsLoaded, providerAccounts, translatorAccounts } from "../composables/chat/providerAccounts";
import { endpointProviders, endpointsLoaded, trialStatus } from "../composables/chat/providerCatalog";
import { useChat } from "../composables/chat/useChat";
import { queryClient } from "../composables/queryPersistence";
import { PANELS } from "../composables/queryKeys";
import { BUILD_IDEAS, buildPrompt } from "./buildIdeas";
import { router } from "../router";
import AgentsView from "./AgentsView.vue";

// The same import-time globals the other mounted-component tests stand up (see startAgent.test.ts).
// matches:false keeps the device DESKTOP, which is the form factor this landing is about.
vi.hoisted(() => {
    globalThis.Element.prototype.scrollIntoView ??= (): void => {};
});

// Unmounted after each test: the board registers its Mod+Z / filter commands in a MODULE-level registry and
// disposes them on unmount, so a second mount in the same file throws "already registered" without this.
const mounted: { unmount: () => void }[] = [];
afterEach(() => {
    for (const app of mounted.splice(0)) {
        app.unmount();
    }
    // The workspace facts are seeded into the query cache by the test that needs them, so they are dropped
    // here rather than left for whichever test mounts next to inherit.
    queryClient.clear();
});

// The connection picture is the axis this screen turns on, so every test states it outright rather than
// inheriting whatever the previous one left. Read: the daemon has answered, and the answer is "nothing", no
// account, and no free trial either, which is what most platforms serve (it is off unless an operator sets keys).
beforeEach(() => {
    accountsLoaded.value = true;
    endpointsLoaded.value = true;
    providerAccounts.value = { ...providerAccounts.value, claude: [], grok: [] };
    translatorAccounts.value = { codex: [], grok: [], kimi: [], gemini: [] };
    endpointProviders.value = [];
    trialStatus.value = { available: false, allowance: 0, used: 0, remaining: 0, health: `unknown` };
});

const mount = (component: unknown): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.appendChild(el);
    const app = createApp({ render: () => h(component as never) });
    app.component(`Icon`, { render: () => null });
    app.directive(`tooltip`, {});
    app.use(router);
    app.use(VueQueryPlugin, { queryClient });
    app.mount(el);
    mounted.push(app);
    return el;
};

const starterNamed = (el: HTMLElement, label: string): HTMLButtonElement | undefined =>
    [...el.querySelectorAll(`button`)].find((button) => button.textContent?.trim() === label);

/* NO SIGN-IN WALL, EVER, which is what this screen used to be whenever nothing could send: a "Try free with
 * Google" card, full width, in the middle of the board, with a row of subscriptions under it. It was the first
 * thing a new user saw after signing in WITH GOOGLE, so it read as a failed sign-in or as a product that needs
 * a subscription, and it was frequently a wall over nothing besides (see the trial's own case below).
 *
 * This mount is the harshest version of that state: the reads have landed, and the answer is genuinely
 * "nothing", no account and no trial either. The board still asks for a task. */
it(`asks for a task rather than for a sign-in, even with nothing connected`, async () => {
    const board = mount(AgentsView);
    await nextTick();

    expect(board.textContent).toContain(`Start your first agent`);
    expect(board.textContent).not.toContain(`Try free with Google`);
    expect([...board.querySelectorAll(`button`)].some((button) => button.textContent?.includes(`Continue with Google`))).toBe(false);
    // Nor the subscription row that came with it: what a chat can send with is answered in the model picker.
    expect(starterNamed(board, `Claude`)).toBeUndefined();
    // And something to press: the build ladder, since this mount has no repositories.
    expect(starterNamed(board, BUILD_IDEAS[0]!.label)).toEqual(expect.any(Object));

    // THE COMPOSER IS GONE. There is one composer in this product and it is the chat's; a second one here could
    // not even send, because a fresh sandbox has nothing connected yet.
    expect(board.querySelector(`textarea`)).toBeNull();
    expect([...board.querySelectorAll(`button`)].some((button) => button.textContent?.includes(`Start agent`))).toBe(false);
});

// This board makes no claim about accounts at all now, so it needs no wait in front of one: an unanswered
// daemon is the chat's business (ChatAccountPanel), and a spinner here would be a second copy of it.
it(`says nothing about accounts while the daemon is still being read`, async () => {
    accountsLoaded.value = false;
    endpointsLoaded.value = false;
    const board = mount(AgentsView);
    await nextTick();

    expect(board.textContent).toContain(`Start your first agent`);
    expect(board.textContent).not.toContain(`Checking your AI accounts…`);
    expect(board.textContent).not.toContain(`Try free with Google`);
});

/* AN EMPTY WORKSPACE OFFERS THE ONE TASK THAT NEEDS NO CODE, and nothing that needs some. The distinction is
 * the whole point of the branch and both halves are pinned here, because each has been got wrong once:
 *   · the chips that proposed cloning and scaffolding are gone and stay gone: getting EXISTING code in is
 *     the workspace pane's offer, made properly there and in an agent's words here
 *   · but the board is not silent either, which is what it was: building something is the only suggestion a
 *     user with an empty box can press and get an artifact from */
it(`offers building on an empty workspace, and nothing that points at code which isn't there`, async () => {
    // A connected Claude subscription: the offer is answered, so the screen goes back to asking for the task.
    providerAccounts.value = { ...providerAccounts.value, claude: [{ id: `a1` }] as never };
    const board = mount(AgentsView);
    await nextTick();

    expect(board.textContent).toContain(`Start your first agent`);

    // No repos and no changes in this mount, so every code-pointing suggestion is absent.
    expect([...board.querySelectorAll(`button`)].map((button) => button.textContent?.trim())).not.toContain(`Bring in my code`);
    expect(starterNamed(board, `Explain this codebase`)).toBeUndefined();
    expect(starterNamed(board, `Review my changes`)).toBeUndefined();

    // And the build ladder is, from the board's own source (buildIdeas.ts).
    for (const example of BUILD_IDEAS) {
        expect(starterNamed(board, example.label)).toEqual(expect.any(Object));
    }
});

// Filled, not sent: the same contract every other starter has, and the reason the chips are suggestions.
it(`fills the composer with the build task rather than sending it`, async () => {
    providerAccounts.value = { ...providerAccounts.value, claude: [{ id: `a1` }] as never };
    const board = mount(AgentsView);
    await nextTick();

    starterNamed(board, BUILD_IDEAS[0]!.label)!.click();
    await nextTick();

    expect(useChat().active.value.draft.value).toBe(buildPrompt(BUILD_IDEAS[0]!.idea));
    expect(useChat().active.value.messages.value).toHaveLength(0);
});

it(`suggests work once the workspace has some, and a starter fills the chat rather than sending`, async () => {
    providerAccounts.value = { ...providerAccounts.value, claude: [{ id: `a1` }] as never };
    // One repository in the workspace, which is what makes "explain this codebase" a thing to press.
    queryClient.setQueryData(PANELS.of(), { panels: [{ repo: `app` }] });
    const board = mount(AgentsView);
    await nextTick();

    const starter = starterNamed(board, `Explain this codebase`);

    const before = useChat().conversations.value.length;
    starter!.click();
    await nextTick();

    // FILLED, NOT SENT: the prompt is in the chat's own composer, no agent was started, and no second tab was
    // opened to hold it.
    expect(useChat().active.value.draft.value).toContain(`Explain this codebase`);
    expect(useChat().active.value.messages.value).toHaveLength(0);
    expect(useChat().conversations.value).toHaveLength(Math.max(before, 1));
    // Still the empty board: filling the composer is not starting anything.
    expect(board.textContent).toContain(`Start your first agent`);
});

/* THE PLATFORM SERVES A FREE TRIAL, which is what a new user on the hosted product actually gets, and the
 * reason the wall this screen used to raise was wrong even when it was raised: the product can answer a
 * question before anything is connected at all. What is pinned is the whole point of the trial: the chat lands
 * ON it, so there is something to send with the moment setup finishes. */
it(`chats on the free trial rather than demanding a sign-in first`, async () => {
    endpointProviders.value = [{ id: TRIAL_PROVIDER, label: `Free trial`, kind: `endpoint` }];
    trialStatus.value = { available: true, allowance: 12, used: 0, remaining: 12, health: `healthy` };
    // The repoint pass is a watcher: it moves the untouched conversation onto the trial on the next flush.
    await nextTick();

    const board = mount(AgentsView);
    await nextTick();

    expect(useChat().active.value.provider.value).toBe(TRIAL_PROVIDER);
    expect(useChat().connected.value).toBe(true);
    expect(board.textContent).toContain(`Start your first agent`);
    expect(board.textContent).not.toContain(`Try free with Google`);
});

// A SPENT ALLOWANCE IS STILL NOT A WALL. The chat can no longer send, and that is the chat's own strip to say;
// this screen keeps asking for a task, because the way out of it is a model choice and not a press on this board.
it(`keeps asking for a task once the trial is used up`, async () => {
    endpointProviders.value = [{ id: TRIAL_PROVIDER, label: `Free trial`, kind: `endpoint` }];
    trialStatus.value = { available: true, allowance: 12, used: 12, remaining: 0, health: `healthy` };
    await nextTick();

    const board = mount(AgentsView);
    await nextTick();

    expect(useChat().connected.value).toBe(false);
    expect(board.textContent).toContain(`Start your first agent`);
    expect([...board.querySelectorAll(`button`)].some((button) => button.textContent?.includes(`Continue with Google`))).toBe(false);
});
