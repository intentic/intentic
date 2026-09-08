// @vitest-environment jsdom
import { VueQueryPlugin } from "@tanstack/vue-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick, ref } from "vue";
import type { Conversation } from "../session/conversation";
import { providerAccounts } from "../accounts/providerAccounts";
import { resetChat, useChat } from "../run/useChat";
import { queryClient } from "../../../lib/queryPersistence";
import { useLayout } from "../../../shell/window/useLayout";
import { router } from "../../../router";
import ChatPanel from "../panel/ChatPanel.vue";
import { IconStub } from "@intentic/ui/testing";

// Asserted through the real composer and DOM, since editing is a mode with no value unless a surface
// offers it. Arming commits nothing (doomed turns stay struck through until retyped); Send is the
// only thing that spends. The conversation-level rewind is pinned in conversation.test.ts.
vi.hoisted(() => {
    globalThis.IntersectionObserver ??= class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
    } as unknown as typeof globalThis.IntersectionObserver;
    globalThis.Element.prototype.scrollIntoView = function scrollIntoView(): void {};
});

vi.mock(`../../agents/fleet/useAgents`, async () => {
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
vi.mock(`../../agents/fleet/useWorkflowRuns`, async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    useWorkflowRuns: () => ({ runs: ref([]), designs: ref([]), start: () => undefined, stop: () => undefined }),
}));
// Import-time globals a mounted chat surface needs.
vi.mock(`../../sandbox/client/useSandbox`, async (importOriginal) => {
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
    app.component(`Icon`, IconStub);
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
// Mocked online; unreachable would yield a footer with no controls, passing every assertion vacuously.
const struck = (): number => document.querySelectorAll(`.chat-doomed`).length;

// Rows the transcript has struck through: what an armed edit would spend.
const editableChat = (): Conversation => {
    const conversation = useChat().active.value;
    conversation.restoreMessages([
        { role: `user`, text: `fix the bug`, checkpointId: `cp-0`, rewindIndex: 0 },
        { role: `assistant`, text: `fixed it` },
        { role: `user`, text: `now ship it`, checkpointId: `cp-2`, rewindIndex: 2 },
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

// A settled two-turn chat with checkpoint anchors already stamped on its rows, reached without the
// network. A message with no anchor (the assistant rows) offers no edit.
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

// Arming costs nothing: the transcript stays whole, the daemon is asked for nothing, and the old
// words wait in the box.
it(`strikes what the send would replace and names the cost over the box`, async () => {
    const conversation = editableChat();
    await mountPanel();

    conversation.beginEdit(conversation.messages.value[0]!);
    await settle();

    // The cost shows in two places: struck rows near the target, and a count over the box for an edit
    // aimed further back where nothing is struck nearby.
    const droppedBelow = struck() - 1;
    expect(struck()).toBe(4);
    expect(paneText()).toContain(`Editing`);
    expect(paneText()).toContain(String(droppedBelow));
    expect(paneText()).toContain(`below`);
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

// Cancel keeps the promise that arming costs nothing: strikes lift and the composer restores whatever
// the pencil displaced.
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

// Escape leaves free, since arming costs nothing: no turn to stop, no transcript to put back.
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

// Send goes down submitEdit, not the ordinary path, since appending at the end would land after the
// turns it's meant to replace.
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
    expect(conversation.editing.value).toEqual(expect.any(Object));
});

// An empty box would drop the turns and ask nothing, an unrequested rewind wearing an edit's
// confirmation; Cancel is the way out.
it(`clears the other things that rewrite what Send means`, async () => {
    const conversation = editableChat();
    conversation.workflowId.value = `wf-1`;
    await mountPanel();

    conversation.beginEdit(conversation.messages.value[0]!);
    await settle();

    expect(conversation.workflowId.value).toBeUndefined();
    expect(conversation.loopId.value).toBeUndefined();
});

// Forks at the same point, carrying the half-written replacement across, so changing your mind costs
// neither the old answer nor the new typing.
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

    // A second chat exists, holding the words that were being typed.
    expect(chat.conversations.value).toHaveLength(2);
    const fork = chat.conversations.value.at(-1)!;
    expect(fork.draft.value).toBe(`ship it to staging first`);
    // This one is untouched: every turn intact, nothing struck, no edit armed.
    expect(conversation.messages.value).toHaveLength(4);
    expect(conversation.editing.value).toBeUndefined();
});
