// @vitest-environment jsdom
//
// ASKING A TURN AGAIN, DIFFERENTLY — asserted through the real composer and read off the DOM, because the whole
// feature is an affordance and a mode on the conversation that no surface offers is worth nothing.
//
// THE ORDER OF EVENTS IS THE FEATURE. A pencil that rewound on the click would destroy the answer before the
// user had decided what to say instead, and an edit abandoned half-way would have already spent it. So arming
// commits nothing, the doomed turns stay on screen struck through for as long as it takes to retype the prompt,
// and the SEND is the confirmation. Everything below is one of those three claims: what arming does (nothing),
// what the box says while it is armed, and what the send finally spends.
//
// The conversation-level half — that the send rewinds before it enqueues, and sends nothing if the rewind is
// refused — is pinned in conversation.test.ts. This file is about the composer.
import { VueQueryPlugin } from "@tanstack/vue-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick, ref } from "vue";
import type { Conversation } from "../composables/chat/conversation";
import { providerAccounts } from "../composables/chat/providerAccounts";
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
// Mocked ONLINE: unreachable, the whole footer yields to "Chat is available once your sandbox is connected" and
// every assertion here would pass against a pane with no controls in it at all.
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

const button = (label: string): HTMLButtonElement | undefined =>
    [...document.querySelectorAll<HTMLButtonElement>(`button`)].find((element) => element.textContent?.trim().startsWith(label));
const paneText = (): string => document.querySelector(`.chat-pane`)?.textContent ?? ``;
const composer = (): HTMLTextAreaElement => document.querySelector<HTMLTextAreaElement>(`.chat-pane textarea`)!;
// The rows the transcript has struck through — what an armed edit would spend, drawn on the messages themselves.
const struck = (): number => document.querySelectorAll(`.chat-doomed`).length;

/* A settled two-turn chat whose prompts the daemon still holds states for — the starting position an edit needs,
 * reached without going near the network. The checkpoint is what carries the anchor: restoreMessages stamps a
 * rewind index on every row the daemon gave one to, and a message with no anchor has nothing to put the files
 * back to, so no edit is offered on it at all. */
const editableChat = (): Conversation => {
    const conversation = useChat().active.value;
    conversation.restoreMessages([
        { role: `user`, text: `fix the bug`, checkpointId: `cp-0` },
        { role: `assistant`, text: `fixed it` },
        { role: `user`, text: `now ship it`, checkpointId: `cp-2` },
        { role: `assistant`, text: `shipped` },
    ]);
    return conversation;
};

beforeEach(async () => {
    app?.unmount();
    app = undefined;
    localStorage.clear();
    resetChat();
    providerAccounts.value = { ...providerAccounts.value, claude: [{ id: `acc-1`, email: `a@b.c` }] as never };
    useLayout().setChatWidth(2000);
    await nextTick();
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    providerAccounts.value = { ...providerAccounts.value, claude: [] };
});

/* ARMING COSTS NOTHING, which is the claim the whole design rests on: the transcript is whole, the daemon has
 * been asked for nothing, and the words are in the box waiting to be changed. */
it(`loads the old prompt into the box and destroys nothing`, async () => {
    const conversation = editableChat();
    const enqueue = vi.spyOn(conversation, `enqueue`).mockResolvedValue(undefined);
    await mountPanel();

    conversation.beginEdit(conversation.messages.value[0]!);
    await settle();

    expect(composer().value).toBe(`fix the bug`);
    expect(conversation.messages.value).toHaveLength(4);
    expect(enqueue).not.toHaveBeenCalled();
});

/* THE COUNT, in the two places it has to be. On the ROWS, because an edit aimed three prompts up spends however
 * much has happened since and that is precisely the quantity nobody holds in their head; and over the BOX,
 * because an edit aimed twenty turns back leaves nothing struck anywhere near the composer — and a box that has
 * silently changed what Send does with no mark on it is the trap this mode is arranged to avoid. */
it(`strikes what the send would replace and names the cost over the box`, async () => {
    const conversation = editableChat();
    await mountPanel();

    conversation.beginEdit(conversation.messages.value[0]!);
    await settle();

    // The edited prompt and the three rows under it.
    expect(struck()).toBe(4);
    expect(paneText()).toContain(`Editing this message`);
    expect(paneText()).toContain(`the 3 below it are replaced when you send`);
});

// Cancelling is the promise that arming costs nothing, kept: the strikes lift, and the composer goes back to
// whatever the pencil displaced rather than coming back empty.
it(`lifts the strikes and returns the displaced draft on cancel`, async () => {
    const conversation = editableChat();
    conversation.draft.value = `something half-written`;
    await mountPanel();

    conversation.beginEdit(conversation.messages.value[2]!);
    await settle();
    expect(struck()).toBe(2);

    button(`Cancel`)!.click();
    await settle();

    expect(struck()).toBe(0);
    expect(composer().value).toBe(`something half-written`);
    expect(conversation.messages.value).toHaveLength(4);
});

// Escape is the plainest way out of a mode, and it is free to mean that here precisely because leaving costs
// nothing — there is no turn to stop and no transcript to put back.
it(`abandons the edit on Escape`, async () => {
    const conversation = editableChat();
    await mountPanel();

    conversation.beginEdit(conversation.messages.value[0]!);
    await settle();

    composer().dispatchEvent(new KeyboardEvent(`keydown`, { key: `Escape`, bubbles: true }));
    await settle();

    expect(conversation.editing.value).toBeUndefined();
    expect(struck()).toBe(0);
});

/* THE SEND, which is the one press that spends anything — and it goes down submitEdit rather than the ordinary
 * send, because an edit appended to the end of the conversation would land after the very turns it was meant to
 * replace. */
it(`sends the replacement through the edit path, not as a new message`, async () => {
    const conversation = editableChat();
    const submitEdit = vi.spyOn(conversation, `submitEdit`).mockResolvedValue(true);
    const enqueue = vi.spyOn(conversation, `enqueue`).mockResolvedValue(undefined);
    await mountPanel();

    conversation.beginEdit(conversation.messages.value[0]!);
    await settle();
    conversation.draft.value = `fix the OTHER bug`;
    await settle();

    composer().dispatchEvent(new KeyboardEvent(`keydown`, { key: `Enter`, bubbles: true }));
    await settle();

    expect(submitEdit).toHaveBeenCalledWith(`fix the OTHER bug`, [], undefined);
    expect(enqueue).not.toHaveBeenCalled();
    expect(composer().value).toBe(``);
});

/* An edit replaces a prompt, so it needs one. An empty box would drop the turns and then ask nothing — a rewind
 * the user never asked for, wearing an edit's confirmation. Cancel is how an edit ends with nothing sent, and it
 * is on screen the whole time. */
it(`refuses to spend an edit on an empty box`, async () => {
    const conversation = editableChat();
    const submitEdit = vi.spyOn(conversation, `submitEdit`).mockResolvedValue(true);
    await mountPanel();

    conversation.beginEdit(conversation.messages.value[0]!);
    await settle();
    conversation.draft.value = ``;
    await settle();

    composer().dispatchEvent(new KeyboardEvent(`keydown`, { key: `Enter`, bubbles: true }));
    await settle();

    expect(submitEdit).not.toHaveBeenCalled();
    expect(conversation.editing.value).toBeDefined();
});

/* THE COMPOSER CANNOT PROMISE TWO THINGS AT ONCE. The agent's voice and the run-through badge's picks answer
 * the same question an edit does — what happens when I press Send — and submit() has to choose one of them. Any
 * arrangement where the loser stays lit is a composer showing a promise it will not keep, so arming an edit
 * clears them where the user can see it happen. */
it(`clears the other things that rewrite what Send means`, async () => {
    const conversation = editableChat();
    conversation.workflowId.value = `wf-1`;
    await mountPanel();

    conversation.beginEdit(conversation.messages.value[0]!);
    await settle();

    expect(conversation.workflowId.value).toBeUndefined();
    expect(conversation.loopId.value).toBeUndefined();
});

/* THE ESCAPE HATCH FROM A DESTRUCTIVE ACT, offered where the doubt happens: half-way through retyping, having
 * just read the answer about to be thrown away. It forks at the same point and carries the half-written
 * replacement across, so changing your mind costs neither the answer nor the typing. */
it(`hands the half-typed replacement to a fork instead, keeping this chat whole`, async () => {
    const chat = useChat();
    const conversation = editableChat();
    await mountPanel();

    conversation.beginEdit(conversation.messages.value[2]!);
    await settle();
    conversation.draft.value = `ship it to staging first`;
    await settle();

    button(`Keep both instead`)!.click();
    await settle();

    // A second chat exists, holding the words that were being typed...
    expect(chat.conversations.value).toHaveLength(2);
    const fork = chat.conversations.value.at(-1)!;
    expect(fork.draft.value).toBe(`ship it to staging first`);
    // ...and this one is exactly as it was: every turn intact, nothing struck, no edit armed.
    expect(conversation.messages.value).toHaveLength(4);
    expect(conversation.editing.value).toBeUndefined();
});
