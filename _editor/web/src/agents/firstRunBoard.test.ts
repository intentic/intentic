// @vitest-environment jsdom
//
// THE EMPTY BOARD, MOUNTED. Out of setup the desktop now lands on /start (router/index.ts, and the screen
// there gives something before it asks for anything) — but this board is still what a user meets the moment
// they leave it, and on a box with nothing on it the things that make it work are easy to break silently: that
// it offers the way in rather than a composer it cannot send from, that the docked chat then drops its copy of
// that offer, that an empty workspace is offered the one task needing no code and none of the ones that need
// some, and that a starter fills the chat's composer rather than dispatching an agent. All are asserted
// against the real component.
import { TRIAL_PROVIDER } from "@intentic/sandbox-contract";
import { VueQueryPlugin } from "@tanstack/vue-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick } from "vue";
import { offerOnBoard } from "../composables/chat/connectOffer";
import { accountsLoaded, providerAccounts, translatorAccounts } from "../composables/chat/providerAccounts";
import { endpointProviders, trialStatus } from "../composables/chat/providerCatalog";
import { useChat } from "../composables/chat/useChat";
import { queryClient } from "../composables/queryPersistence";
import { PANELS } from "../composables/queryKeys";
import { BUILD_IDEAS, buildPrompt } from "../pages/start/firstRun";
import { router } from "../router";
import AgentsView from "./AgentsView.vue";

// The same import-time globals the other mounted-component tests stand up (see startAgent.test.ts).
// matches:false keeps the device DESKTOP, which is the form factor this landing is about.
vi.hoisted(() => {
    globalThis.Element.prototype.scrollIntoView ??= (): void => {};
    globalThis.ResizeObserver ??= class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
    };
    globalThis.matchMedia ??= ((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
    })) as unknown as typeof globalThis.matchMedia;
    globalThis.window.env ??= {
        production: false,
        api: { url: `http://localhost` },
        auth: { googleClientId: `` },
        analytics: { posthogKey: ``, posthogHost: `` },
        afterSignOut: ``,
    };
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
// inheriting whatever the previous one left. Read: the daemon has answered, and the answer is "nothing" — no
// account, and no free trial either, which is what most platforms serve (it is off unless an operator sets keys).
beforeEach(() => {
    accountsLoaded.value = true;
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

it(`offers the way in rather than a box it cannot send from, and the docked chat stands down`, async () => {
    const board = mount(AgentsView);
    await nextTick();

    // The free channel, in the middle of the board — the same card the chat's gate shows (ConnectOffer).
    expect(board.textContent).toContain(`Try free with Google`);
    expect([...board.querySelectorAll(`button`)].some((button) => button.textContent?.includes(`Continue with Google`))).toBe(true);
    // And the subscriptions under it, for a user who already pays for one.
    expect(starterNamed(board, `Claude`)).toBeDefined();

    // THE COMPOSER IS GONE. There is one composer in this product and it is the chat's; a second one here could
    // not even send, because a fresh sandbox has nothing connected yet.
    expect(board.querySelector(`textarea`)).toBeNull();
    expect([...board.querySelectorAll(`button`)].some((button) => button.textContent?.includes(`Start agent`))).toBe(false);

    // The claim the docked gate reads, so the same offer is never argued twice on one screen.
    expect(offerOnBoard.value).toBe(true);
});

it(`waits for the daemon before claiming nothing is connected`, async () => {
    accountsLoaded.value = false;
    const board = mount(AgentsView);
    await nextTick();

    // "You have nothing connected" is a claim, and until the read lands it is one this screen may not make —
    // but the wait belongs to it too, or the chat would spin beside it saying the same thing.
    expect(board.textContent).toContain(`Checking your AI accounts…`);
    expect(board.textContent).not.toContain(`Try free with Google`);
    expect(offerOnBoard.value).toBe(true);
});

/* AN EMPTY WORKSPACE OFFERS THE ONE TASK THAT NEEDS NO CODE, and nothing that needs some. The distinction is
 * the whole point of the branch and both halves are pinned here, because each has been got wrong once:
 *   · the chips that proposed cloning and scaffolding are gone and stay gone — getting EXISTING code in is
 *     the workspace pane's offer, made properly there and in an agent's words here
 *   · but the board is not silent either, which is what it was: building something is the only suggestion a
 *     user with an empty box can press and get an artifact from */
it(`offers building on an empty workspace, and nothing that points at code which isn't there`, async () => {
    // A connected Claude subscription: the offer is answered, so the screen goes back to asking for the task.
    providerAccounts.value = { ...providerAccounts.value, claude: [{ id: `a1` }] as never };
    const board = mount(AgentsView);
    await nextTick();

    expect(board.textContent).not.toContain(`Try free with Google`);
    expect(offerOnBoard.value).toBe(false);
    expect(board.textContent).toContain(`Start your first agent`);

    // No repos and no changes in this mount, so every code-pointing suggestion is absent.
    expect([...board.querySelectorAll(`button`)].map((button) => button.textContent?.trim())).not.toContain(`Bring in my code`);
    expect(starterNamed(board, `Explain this codebase`)).toBeUndefined();
    expect(starterNamed(board, `Review my changes`)).toBeUndefined();

    // And the build ladder is, from the shared source the first-run screen uses.
    for (const example of BUILD_IDEAS) {
        expect(starterNamed(board, example.label)).toBeDefined();
    }
});

// Filled, not sent — the same contract every other starter has, and the reason the chips are suggestions.
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
    expect(starter).toBeDefined();

    const before = useChat().conversations.value.length;
    starter!.click();
    await nextTick();

    // FILLED, NOT SENT: the prompt is in the chat's own composer, no agent was started, and no second tab was
    // opened to hold it.
    expect(useChat().active.value.draft.value).toContain(`Explain this codebase`);
    expect(useChat().active.value.messages.value).toHaveLength(0);
    expect(useChat().conversations.value).toHaveLength(Math.max(before, 1));
    // Still the first-run screen — filling the composer is not starting anything.
    expect(board.textContent).toContain(`Start your first agent`);
});

/* THE PLATFORM SERVES A FREE TRIAL, which is the case this whole screen used to get wrong: the product could
 * already answer a question with nothing connected, and the first thing it showed anybody was a wall of
 * sign-ins. A user who has just finished setup should be able to type.
 *
 * What the trial changes here is which of the two shapes this screen takes, so both halves are asserted: the
 * offer stops being the screen (the chat one column over has a live composer, so the board goes back to asking
 * for a task and hands the gate back), and it does NOT leave the screen — the free Google sign-in is the rung
 * above the trial, with no daily cap, and hiding it until the allowance ran out would hide the better deal. */
it(`chats on the free trial rather than demanding a sign-in first`, async () => {
    endpointProviders.value = [{ id: TRIAL_PROVIDER, label: `Free trial` }];
    trialStatus.value = { available: true, allowance: 12, used: 0, remaining: 12, health: `healthy` };
    // The repoint pass is a watcher: it moves the untouched conversation onto the trial on the next flush.
    await nextTick();

    const board = mount(AgentsView);
    await nextTick();

    expect(useChat().active.value.provider.value).toBe(TRIAL_PROVIDER);
    expect(useChat().connected.value).toBe(true);
    // The board asks for the task, and gives the docked chat its gate back.
    expect(board.textContent).toContain(`Start your first agent`);
    expect(offerOnBoard.value).toBe(false);
    // Demoted, not gone.
    expect(board.textContent).toContain(`Try free with Google`);
});

// And the moment the allowance is spent the trial stops being a way to send, so the offer takes the screen
// back — the one press that removes the daily cap, at the moment it becomes the only way on.
it(`hands the screen back to the offer once the trial is used up`, async () => {
    endpointProviders.value = [{ id: TRIAL_PROVIDER, label: `Free trial` }];
    trialStatus.value = { available: true, allowance: 12, used: 12, remaining: 0, health: `healthy` };
    await nextTick();

    const board = mount(AgentsView);
    await nextTick();

    expect(useChat().connected.value).toBe(false);
    expect(offerOnBoard.value).toBe(true);
    expect([...board.querySelectorAll(`button`)].some((button) => button.textContent?.includes(`Continue with Google`))).toBe(true);
});
