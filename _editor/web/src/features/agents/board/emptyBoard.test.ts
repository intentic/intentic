// @vitest-environment jsdom
// The empty board mounted, the first screen most new users see: asserts it asks for a task rather than a sign-in with
// whatever this sandbox can send, offers the one task needing no code and none needing some, and that starters fill the
// composer rather than dispatching an agent.
import { TRIAL_PROVIDER } from "@intentic/sandbox-contract";
import { VueQueryPlugin } from "@tanstack/vue-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick } from "vue";
import { accountsLoaded, providerAccounts, translatorAccounts } from "../../chat/accounts/providerAccounts";
import { endpointProviders, endpointsLoaded, trialStatus } from "../../chat/accounts/providerCatalog";
import { useChat } from "../../chat/run/useChat";
import { queryClient } from "../../../lib/queryPersistence";
import { PANELS } from "../../../lib/queryKeys";
import { BUILD_IDEAS, buildPrompt } from "./buildIdeas";
import { router } from "../../../router";
import AgentsView from "./AgentsView.vue";
import { IconStub } from "@intentic/ui/testing";

// Same import-time globals as other mounted-component tests; matches:false keeps the device desktop.
vi.hoisted(() => {
    globalThis.Element.prototype.scrollIntoView ??= (): void => {};
});

// Unmounted after each test: the board registers Mod+Z / filter commands in a module-level registry and throws "already
// registered" on a second mount without this.
const mounted: { unmount: () => void }[] = [];
afterEach(() => {
    for (const app of mounted.splice(0)) {
        app.unmount();
    }
    // Workspace facts are seeded per test into the query cache; dropped here so the next mount doesn't inherit them.
    queryClient.clear();
});

// Every test states the connection picture outright: the daemon has answered, and answered with nothing connected and
// no free trial (off unless an operator sets keys).
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
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.use(router);
    app.use(VueQueryPlugin, { queryClient });
    app.mount(el);
    mounted.push(app);
    return el;
};

const starterNamed = (el: HTMLElement, label: string): HTMLButtonElement | undefined =>
    [...el.querySelectorAll(`button`)].find((button) => button.textContent?.trim() === label);

// This board must never show a sign-in wall, even when the daemon confirms no account and no trial are available.
it(`asks for a task rather than for a sign-in, even with nothing connected`, async () => {
    const board = mount(AgentsView);
    await nextTick();

    expect(board.textContent).toContain(`first agent`);
    expect(board.textContent).not.toContain(`Try free with Google`);
    expect([...board.querySelectorAll(`button`)].some((button) => button.textContent?.includes(`Continue with Google`))).toBe(false);
    // Nor the subscription row that came with it: what a chat can send with is answered in the model picker.
    expect(starterNamed(board, `Claude`)).toBeUndefined();
    // Something to press: the build ladder, since this mount has no repositories.
    expect(starterNamed(board, BUILD_IDEAS[0]!.label)).toEqual(expect.any(Object));

    // There is one composer in this product, the chat's; a second one here couldn't even send, since nothing is
    // connected yet.
    expect(board.querySelector(`textarea`)).toBeNull();
    expect([...board.querySelectorAll(`button`)].some((button) => button.textContent?.includes(`Start agent`))).toBe(false);
});

// This board makes no claim about accounts now: an unanswered daemon is the chat's own business (ChatAccountPanel).
it(`says nothing about accounts while the daemon is still being read`, async () => {
    accountsLoaded.value = false;
    endpointsLoaded.value = false;
    const board = mount(AgentsView);
    await nextTick();

    expect(board.textContent).toContain(`first agent`);
    expect(board.textContent).not.toContain(`Checking your AI accounts…`);
    expect(board.textContent).not.toContain(`Try free with Google`);
});

// An empty workspace offers only the one task needing no code, never a chip for cloning or scaffolding existing code:
// that offer belongs to the workspace pane.
it(`offers building on an empty workspace, and nothing that points at code which isn't there`, async () => {
    // A connected Claude subscription: the offer is answered, so the screen goes back to asking for the task.
    providerAccounts.value = { ...providerAccounts.value, claude: [{ id: `a1` }] as never };
    const board = mount(AgentsView);
    await nextTick();

    expect(board.textContent).toContain(`first agent`);

    // No repos and no changes in this mount, so every code-pointing suggestion is absent.
    expect([...board.querySelectorAll(`button`)].map((button) => button.textContent?.trim())).not.toContain(`Bring in my code`);
    expect(starterNamed(board, `Explain this codebase`)).toBeUndefined();
    expect(starterNamed(board, `Review my changes`)).toBeUndefined();

    // The build ladder is drawn from its own source (buildIdeas.ts).
    for (const example of BUILD_IDEAS) {
        expect(starterNamed(board, example.label)).toEqual(expect.any(Object));
    }
});

// Filled, not sent: the same contract every other starter has.
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
    // One repository in the workspace, which is what makes "Explain this codebase" a thing to press.
    queryClient.setQueryData(PANELS.of(), { panels: [{ repo: `app` }] });
    const board = mount(AgentsView);
    await nextTick();

    const starter = starterNamed(board, `Explain this codebase`);

    const before = useChat().conversations.value.length;
    starter!.click();
    await nextTick();

    // Filled, not sent: the prompt sits in the chat's own composer, no agent started, no second tab opened.
    expect(useChat().active.value.draft.value).toContain(`Explain this codebase`);
    expect(useChat().active.value.messages.value).toHaveLength(0);
    expect(useChat().conversations.value).toHaveLength(Math.max(before, 1));
    // Still the empty board: filling the composer is not starting anything.
    expect(board.textContent).toContain(`first agent`);
});

// The hosted product can answer a question before anything is connected: the chat lands on the free trial so there's
// something to send with immediately.
it(`chats on the free trial rather than demanding a sign-in first`, async () => {
    endpointProviders.value = [{ id: TRIAL_PROVIDER, label: `Free trial`, kind: `endpoint` }];
    trialStatus.value = { available: true, allowance: 12, used: 0, remaining: 12, health: `healthy` };
    // The repoint pass is a watcher that moves the untouched conversation onto the trial on the next flush.
    await nextTick();

    const board = mount(AgentsView);
    await nextTick();

    expect(useChat().active.value.provider.value).toBe(TRIAL_PROVIDER);
    expect(useChat().connected.value).toBe(true);
    expect(board.textContent).toContain(`first agent`);
    expect(board.textContent).not.toContain(`Try free with Google`);
});

// A spent allowance is still not a wall: the chat can't send, which is the chat's own strip to say, not this board's.
it(`keeps asking for a task once the trial is used up`, async () => {
    endpointProviders.value = [{ id: TRIAL_PROVIDER, label: `Free trial`, kind: `endpoint` }];
    trialStatus.value = { available: true, allowance: 12, used: 12, remaining: 0, health: `healthy` };
    await nextTick();

    const board = mount(AgentsView);
    await nextTick();

    expect(useChat().connected.value).toBe(false);
    expect(board.textContent).toContain(`first agent`);
    expect([...board.querySelectorAll(`button`)].some((button) => button.textContent?.includes(`Continue with Google`))).toBe(false);
});
