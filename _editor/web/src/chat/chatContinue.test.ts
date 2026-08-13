// @vitest-environment jsdom
//
// THE WAY BACK FROM A TURN THAT STOPPED, asserted through the real composer and read off the DOM — because the
// whole feature is an affordance, and a flag on the conversation that no surface offers is worth nothing.
//
// It comes from the report behind it: a turn ends ("agent did not complete"), or the user declines a tool and
// the agent halts waiting to be told what to do, and the only way on is to type the word "Continue" into the
// box. Every time. The three things that have to be true for that to stop are all here — the strip appears with
// its button, Enter on an empty composer does the same thing, and neither of them shows up on a chat where
// continuing would be wrong.
import { VueQueryPlugin } from "@tanstack/vue-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick, ref } from "vue";
import type { Conversation } from "../composables/chat/conversation";
import { providerAccounts } from "../composables/chat/providerAccounts";
import { CONTINUATIONS } from "../composables/chat/transcript";
import { resetChat, useChat } from "../composables/chat/useChat";
import { queryClient } from "../composables/queryPersistence";
import { useLayout } from "../composables/useLayout";
import { router } from "../router";
import ChatPanel from "./ChatPanel.vue";

// The import-time globals a mounted chat surface needs — see chatPanelPanes.test.ts, which explains each.
vi.hoisted(() => {
    globalThis.ResizeObserver ??= class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
    };
    globalThis.IntersectionObserver ??= class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
    } as unknown as typeof globalThis.IntersectionObserver;
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
    globalThis.Element.prototype.scrollIntoView = function scrollIntoView(): void {};
});

// The fleet roster and the workflow ledger, which the pane asks about on mount and neither of which this file
// is about — an empty answer costs nothing and keeps the polling out of it.
vi.mock(`../composables/agents/useAgents`, async () => {
    const { computed } = await import(`vue`);
    return {
        useAgents: () => ({
            fleet: computed(() => []),
            agentById: () => undefined,
            archived: ref([]),
            loadArchived: () => {},
            restore: () => {},
            busyIds: ref([]),
        }),
    };
});
vi.mock(`../composables/agents/useWorkflowRuns`, async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    useWorkflowRuns: () => ({ runs: ref([]), designs: ref([]), start: () => undefined, stop: () => undefined }),
}));
/* THE COMPOSER ONLY EXISTS WHEN THE SANDBOX DOES: unreachable, the whole footer yields to "Chat is available
 * once your sandbox is connected", and every assertion below would pass against a pane with no controls in it
 * at all. So this one is mocked ONLINE — the state the feature lives in. */
vi.mock(`../composables/sandbox/useSandbox`, async (importOriginal) => {
    const { computed } = await import(`vue`);
    const activeSandboxId = ref<string | undefined>(`sandbox-1`);
    const sandboxes = ref([{ id: `sandbox-1`, name: `test` }]);
    return {
        ...(await importOriginal<Record<string, unknown>>()),
        useSandbox: () => ({
            sandboxes,
            activeSandboxId,
            active: computed(() => sandboxes.value[0]),
            daemonUrl: computed(() => `http://localhost`),
            connection: ref({ phase: `online` }),
            reachable: ref(true),
            list: { isPending: ref(false) },
            refresh: () => {},
            select: () => {},
            create: () => {},
            update: () => {},
            attach: () => {},
            remove: () => {},
        }),
    };
});

let app: App | undefined;

const settle = async (): Promise<void> => {
    await nextTick();
    await nextTick();
    await nextTick();
};

const mountPanel = async (): Promise<void> => {
    const el = document.createElement(`div`);
    document.body.appendChild(el);
    app = createApp({ render: () => h(ChatPanel) });
    app.component(`Icon`, { render: () => null });
    app.directive(`tooltip`, {});
    app.use(router);
    app.use(VueQueryPlugin, { queryClient });
    app.mount(el);
    await settle();
};

// The offer, as the DOM has it: the button that carries the word, or nothing.
const continueButton = (): HTMLButtonElement | undefined =>
    [...document.querySelectorAll<HTMLButtonElement>(`button`)].find((button) => button.textContent?.trim().startsWith(`Continue`));
// The one hint slot under the box — how anyone learns the key exists.
const composerText = (): string => document.querySelector(`.chat-pane`)?.textContent ?? ``;
const composer = (): HTMLTextAreaElement => document.querySelector<HTMLTextAreaElement>(`.chat-pane textarea`)!;

/* A chat whose last turn stopped before it finished, without going near the network to get there: `resumable`
 * is the state a failed turn LEAVES, and conversation.test.ts is where the failures that leave it are pinned.
 * Here it is a starting position, so this file can be about what the composer does with it. */
const stoppedChat = (): Conversation => {
    const chat = useChat();
    const conversation = chat.active.value;
    conversation.restoreMessages([
        { role: `user`, text: `clean the sandbox` },
        { role: `assistant`, text: `starting` },
    ]);
    conversation.resumable.value = true;
    return conversation;
};

beforeEach(async () => {
    app?.unmount();
    app = undefined;
    localStorage.clear();
    resetChat();
    // `connected` is the composer's own gate — with no account on the provider the box is inert and says so.
    providerAccounts.value = { ...providerAccounts.value, claude: [{ id: `acc-1`, email: `a@b.c` }] as never };
    useLayout().setChatWidth(2000);
    await nextTick();
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    providerAccounts.value = { ...providerAccounts.value, claude: [] };
});

it(`offers the stopped turn a way on, and sends the sentence when it is pressed`, async () => {
    const conversation = stoppedChat();
    const enqueue = vi.spyOn(conversation, `enqueue`).mockResolvedValue(undefined);
    await mountPanel();

    expect(composerText()).toContain(`This turn stopped before it finished`);
    // The key is named ON the button, so the reader who has already reached for the mouse learns it anyway.
    expect(continueButton()?.textContent).toContain(`Enter`);

    continueButton()!.click();
    await settle();

    expect(enqueue).toHaveBeenCalledWith(CONTINUATIONS.plain, undefined, undefined);
});

/* THE WHOLE POINT, in one keystroke. Enter on an empty box did nothing at all before this, so there is no habit
 * being broken — and the hint slot has to say so, because a shortcut nothing advertises is a shortcut only its
 * author uses. */
it(`makes Enter on an empty composer continue, and says so under the box`, async () => {
    const conversation = stoppedChat();
    const enqueue = vi.spyOn(conversation, `enqueue`).mockResolvedValue(undefined);
    await mountPanel();

    expect(composerText()).toContain(`Enter to continue`);
    composer().dispatchEvent(new KeyboardEvent(`keydown`, { key: `Enter`, bubbles: true }));
    await settle();

    expect(enqueue).toHaveBeenCalledWith(CONTINUATIONS.plain, undefined, undefined);
});

/* WHAT THE OFFER MUST NOT DO. Typing is the user saying what happens next in their own words, so the strip goes
 * and the key goes back to sending the draft — a Continue that fired over a half-written message, or an Enter
 * that sent "continue" instead of what was in the box, would be worse than the typing it replaced. */
it(`stands down the moment the user types something of their own`, async () => {
    const conversation = stoppedChat();
    const enqueue = vi.spyOn(conversation, `enqueue`).mockResolvedValue(undefined);
    await mountPanel();
    expect(continueButton()).toBeDefined();

    conversation.draft.value = `actually, run the tests first`;
    await settle();

    expect(continueButton()).toBeUndefined();
    expect(composerText()).not.toContain(`This turn stopped before it finished`);
    composer().dispatchEvent(new KeyboardEvent(`keydown`, { key: `Enter`, bubbles: true }));
    await settle();
    expect(enqueue).toHaveBeenCalledWith(`actually, run the tests first`, [], undefined);
});

// A chat that ended cleanly is not offered anything: the strip is for work left hanging, and one that showed up
// after every finished answer would be noise the reader learns to look past — including on the turns it matters.
it(`says nothing on a chat whose turn finished`, async () => {
    const chat = useChat();
    chat.active.value.restoreMessages([
        { role: `user`, text: `clean the sandbox` },
        { role: `assistant`, text: `done` },
    ]);
    await mountPanel();

    expect(continueButton()).toBeUndefined();
    expect(composerText()).not.toContain(`Enter to continue`);
});
