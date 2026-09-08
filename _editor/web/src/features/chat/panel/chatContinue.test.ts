// @vitest-environment jsdom
// Pins the way back from a turn that stopped, through the real composer and the DOM: the strip and its button,
// Enter-to-continue, and their absence where continuing would be wrong.
import { VueQueryPlugin } from "@tanstack/vue-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick, ref } from "vue";
import type { Conversation } from "../session/conversation";
import { providerAccounts, setAccountUsage } from "../accounts/providerAccounts";
import { CONTINUATIONS } from "../transcript/transcript";
import { resetChat, useChat } from "../run/useChat";
import { queryClient } from "../../../lib/queryPersistence";
import { SANDBOX_BUSY_AFTER_MS } from "../../sandbox/overview/availability";
import { useLayout } from "../../../shell/window/useLayout";
import { router } from "../../../router";
import ChatPanel from "./ChatPanel.vue";
import { IconStub } from "@intentic/ui/testing";

// Import-time globals a mounted chat surface needs.
vi.hoisted(() => {
    globalThis.IntersectionObserver ??= class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
    } as unknown as typeof globalThis.IntersectionObserver;
    globalThis.Element.prototype.scrollIntoView = function scrollIntoView(): void {};
});

// Fleet roster and workflow ledger the pane queries on mount; irrelevant here, so answered empty.
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
            setResumeAfterOutage: vi.fn().mockResolvedValue(undefined),
        }),
    };
});
vi.mock(`../../agents/fleet/useWorkflowRuns`, async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    useWorkflowRuns: () => ({ runs: ref([]), designs: ref([]), start: () => undefined, stop: () => undefined }),
}));
// The composer only renders once the sandbox is reachable; mocked online here, the state this file tests.
const { sandboxReachable, sandboxConnection, ONLINE_CONNECTION } = await vi.hoisted(async () => {
    const { ref: vueRef } = await import(`vue`);
    // Steady state for this file: `reachable` alone can't distinguish briefly retrying from down for a while.
    const online = { phase: `online`, failure: undefined, attempt: 0, retryDelayMs: 0, everOnline: true, unavailableSince: undefined, generation: 0 };
    return { sandboxReachable: vueRef(true), sandboxConnection: vueRef({ ...online }), ONLINE_CONNECTION: online };
});
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
            connection: sandboxConnection,
            reachable: sandboxReachable,
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

// Stubbed at the composable, not the transport: whether the offer exists is the provider's judgement, and this file is
// about what the strip does with it.
const { resetOffer, claimReset } = await vi.hoisted(async () => {
    const { ref: vueRef } = await import(`vue`);
    // A ref, since a claim retiring the offer must repaint the strip.
    return { resetOffer: vueRef<unknown>(undefined), claimReset: vi.fn() };
});
vi.mock(`../session/limitReset`, async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    askLimitReset: vi.fn().mockResolvedValue(undefined),
    limitResetFor: () => resetOffer.value,
    claimLimitReset: claimReset,
}));

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

// Matches a button by its visible text prefix.
const button = (label: string): HTMLButtonElement | undefined =>
    [...document.querySelectorAll<HTMLButtonElement>(`button`)].find((element) => element.textContent?.trim().startsWith(label));
const continueButton = (): HTMLButtonElement | undefined => button(`Continue`);
// Caret opening the press's variants; absent when the menu would have nothing in it.
const waysButton = (): HTMLButtonElement | undefined => document.querySelector<HTMLButtonElement>(`button[aria-label="Other ways on"]`) ?? undefined;
// jsdom rects are 0x0; AnchoredOverlay treats that as gone and self-closes, so give the anchor a box first.
const ANCHOR_BOX = { x: 0, y: 0, top: 0, left: 0, bottom: 24, right: 160, width: 160, height: 24, toJSON: () => ({}) } as DOMRect;
const openWays = async (): Promise<void> => {
    const caret = waysButton()!;
    caret.parentElement!.getBoundingClientRect = (): DOMRect => ANCHOR_BOX;
    caret.click();
    await settle();
};
const composerText = (): string => document.querySelector(`.chat-pane`)?.textContent ?? ``;
const composer = (): HTMLTextAreaElement => document.querySelector<HTMLTextAreaElement>(`.chat-pane textarea`)!;

// A chat whose last turn stopped, built directly rather than through a failure path, as a starting position for these
// tests.
const stoppedChat = (): Conversation => {
    const chat = useChat();
    const conversation = chat.active.value;
    conversation.restoreMessages([
        { role: `user`, text: `clean the sandbox` },
        { role: `assistant`, text: `starting` },
    ]);
    conversation.pickUp.value = { reason: `stopped` };
    return conversation;
};

beforeEach(async () => {
    app?.unmount();
    app = undefined;
    // Clears both: tabs live in sessionStorage, seeded from localStorage; else a pick-up leaks into the next test.
    localStorage.clear();
    sessionStorage.clear();
    resetChat();
    sandboxReachable.value = true;
    sandboxConnection.value = { ...ONLINE_CONNECTION };
    // `connected` is the composer's own gate; with no account the box goes inert.
    providerAccounts.value = { ...providerAccounts.value, claude: [{ id: `acc-1`, email: `a@b.c` }] as never };
    useLayout().setChatWidth(2000);
    // Baseline: no grant offered, the state every test but the reset tests itself runs in.
    resetOffer.value = undefined;
    claimReset.mockReset();
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

    expect(composerText()).toContain(`Turn stopped short · work kept`);
    expect(continueButton()?.textContent?.trim()).toBe(`Continue`);

    continueButton()!.click();
    await settle();

    expect(enqueue).toHaveBeenCalledWith(CONTINUATIONS.plain);
});

it(`makes Enter on an empty composer continue, and says so under the box`, async () => {
    const conversation = stoppedChat();
    const enqueue = vi.spyOn(conversation, `enqueue`).mockResolvedValue(undefined);
    await mountPanel();

    expect(composerText()).toContain(`Enter to continue`);
    composer().dispatchEvent(new KeyboardEvent(`keydown`, { key: `Enter`, bubbles: true }));
    await settle();

    expect(enqueue).toHaveBeenCalledWith(CONTINUATIONS.plain);
});

it(`stands down the moment the user types something of their own`, async () => {
    const conversation = stoppedChat();
    const enqueue = vi.spyOn(conversation, `enqueue`).mockResolvedValue(undefined);
    await mountPanel();
    expect(continueButton()).toEqual(expect.any(Object));

    conversation.draft.value = `actually, run the tests first`;
    await settle();

    expect(continueButton()).toBeUndefined();
    expect(composerText()).not.toContain(`stopped`);
    composer().dispatchEvent(new KeyboardEvent(`keydown`, { key: `Enter`, bubbles: true }));
    await settle();
    expect(enqueue).toHaveBeenCalledWith(`actually, run the tests first`, [], undefined);
});

// When only Continue and Auto-continue exist, Auto-continue shows directly as a button, not behind the caret.
it(`offers to keep continuing by itself, and says so once it is on`, async () => {
    const conversation = stoppedChat();
    await mountPanel();

    expect(button(`Auto-continue`)).toEqual(expect.any(Object));
    button(`Auto-continue`)!.click();
    await settle();

    expect(conversation.autoContinue.value).toBe(true);
    expect(composerText()).toContain(`Auto-continue is on`);
    expect(button(`Auto-continue`)).toBeUndefined();
    expect(waysButton()).toBeUndefined();
    expect(continueButton()).toEqual(expect.any(Object));

    button(`Turn off`)!.click();
    await settle();
    expect(conversation.autoContinue.value).toBe(false);
    expect(composerText()).not.toContain(`Auto-continue is on`);
});

it(`keeps the armed line up on a chat with nothing to continue`, async () => {
    const chat = useChat();
    const conversation = chat.active.value;
    conversation.restoreMessages([
        { role: `user`, text: `clean the sandbox` },
        { role: `assistant`, text: `done` },
    ]);
    conversation.setAutoContinue(true);
    await mountPanel();

    expect(continueButton()).toBeUndefined();
    expect(composerText()).toContain(`Auto-continue is on`);
    expect(button(`Turn off`)).toEqual(expect.any(Object));
});

// An unheld allowance means the daemon has no copy of the refused turn, so nothing can be resumed before it resets.
it(`counts an unheld allowance down instead of going quiet, and keeps the press inert until it resets`, async () => {
    const conversation = stoppedChat();
    const enqueue = vi.spyOn(conversation, `enqueue`).mockResolvedValue(undefined);
    conversation.pickUp.value = { reason: `limit`, readyAt: Date.now() + 3_600_000 };
    await mountPanel();

    expect(composerText()).toContain(`Limit reached`);
    expect(composerText()).toContain(`about 60 min`);
    expect(continueButton()?.disabled).toBe(true);
    expect(composerText()).not.toContain(`Enter to continue`);
    composer().dispatchEvent(new KeyboardEvent(`keydown`, { key: `Enter`, bubbles: true }));
    await settle();
    expect(enqueue).not.toHaveBeenCalled();
});

it(`offers a held allowance the press straight away, and re-runs the turn instead of saying anything`, async () => {
    const conversation = stoppedChat();
    const enqueue = vi.spyOn(conversation, `enqueue`).mockResolvedValue(undefined);
    const rerun = vi.spyOn(conversation, `resumeHeldTurn`).mockResolvedValue(true);
    conversation.pickUp.value = { reason: `limit`, readyAt: Date.now() + 8 * 3_600_000, held: { ran: false } };
    await mountPanel();

    expect(composerText()).toContain(`Limit reached · nothing ran · back`);
    expect(composerText()).not.toContain(`work kept`);
    expect(continueButton()?.disabled).toBe(false);
    expect(composerText()).toContain(`Enter to continue`);

    continueButton()!.click();
    await settle();

    expect(rerun).toHaveBeenCalledTimes(1);
    expect(enqueue).not.toHaveBeenCalled();
});

// Held vs. refused picks the resume note (RESUME_NOTES.refused vs .limit): the wrong one either invents context for the
// model or misinforms the reader.
it(`tells a mid-turn allowance failure apart from one that refused the turn outright`, async () => {
    const conversation = stoppedChat();
    conversation.pickUp.value = { reason: `limit`, readyAt: Date.now() + 3_600_000, held: { ran: true } };
    await mountPanel();

    expect(composerText()).toContain(`Limit reached · work kept · back`);
    expect(continueButton()?.disabled).toBe(false);
});

it(`hands the press over once the allowance has reset`, async () => {
    const conversation = stoppedChat();
    const enqueue = vi.spyOn(conversation, `enqueue`).mockResolvedValue(undefined);
    conversation.pickUp.value = { reason: `limit`, readyAt: Date.now() - 1_000 };
    await mountPanel();

    expect(continueButton()?.disabled).toBe(false);
    expect(composerText()).toContain(`Enter to continue`);
    continueButton()!.click();
    await settle();

    expect(enqueue).toHaveBeenCalledWith(CONTINUATIONS.plain);
});

it(`carries the outage in the same strip, with the way out of its automatic retry`, async () => {
    const conversation = stoppedChat();
    conversation.pickUp.value = { reason: `outage`, automatic: { at: Date.now() + 120_000 } };
    await mountPanel();

    expect(composerText()).toContain(`Provider failed · retrying in about 2 min`);
    expect(composerText()).toContain(`Stop`);
    expect(waysButton()).toBeUndefined();
    expect(button(`Auto-continue`)).toBeUndefined();
    expect(continueButton()?.disabled).toBe(false);
});

it(`offers to keep the chat going when nothing is retrying the outage`, async () => {
    const conversation = stoppedChat();
    conversation.pickUp.value = { reason: `outage` };
    await mountPanel();

    expect(button(`Keep this chat going`)).toEqual(expect.any(Object));
    expect(continueButton()?.disabled).toBe(false);
});

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

const statusRow = (): string => document.querySelector<HTMLAnchorElement>(`a[href="/sandbox/agent"]`)?.textContent ?? ``;
const sendButton = (): HTMLButtonElement => document.querySelector<HTMLButtonElement>(`button[aria-label="Send"]`)!;
// State a healthy workspace passes through often: the reconnect ladder's first rung is about a second.
const retrying = (sinceMsAgo: number): void => {
    sandboxReachable.value = false;
    sandboxConnection.value = {
        ...ONLINE_CONNECTION,
        phase: `retrying`,
        failure: { kind: `timeout`, message: `The sandbox stopped responding.` },
        attempt: 1,
        retryDelayMs: 1000,
        unavailableSince: Date.now() - sinceMsAgo,
    } as never;
};

// Send goes inert immediately, since transport truth is instant, but the busy wording waits for SANDBOX_BUSY_AFTER_MS
// so a routine reconnect doesn't read as an outage.
it(`says nothing about a reconnect short enough to heal itself`, async () => {
    useChat().active.value.draft.value = `hello`;
    await mountPanel();

    expect(statusRow()).toContain(`online · Manage`);
    expect(sendButton().disabled).toBe(false);

    retrying(1_000);
    await settle();

    expect(statusRow()).toContain(`online · Manage`);
    expect(composerText()).not.toContain(`The sandbox is busy`);
    expect(sendButton().disabled).toBe(true);
});

it(`names a wait that has outlasted the busy threshold`, async () => {
    useChat().active.value.draft.value = `hello`;
    await mountPanel();

    retrying(SANDBOX_BUSY_AFTER_MS + 1_000);
    await settle();

    expect(statusRow()).toContain(`busy, catching up · Manage`);
    expect(sendButton().disabled).toBe(true);
});

// A second connected subscription lets a spent allowance's held turn move there in one press, instead of switching
// accounts and pressing Continue separately.

// Two connections: the first spent, the second with room, the state this offer exists for.
const twoAccounts = (spentPercent: number, roomPercent: number): void => {
    providerAccounts.value = {
        ...providerAccounts.value,
        claude: [
            { id: `acc-1`, email: `first@b.c` },
            { id: `acc-2`, email: `second@b.c` },
        ] as never,
    };
    setAccountUsage(`claude`, `acc-1`, { windows: [{ kind: `five_hour`, utilization: spentPercent, gates: `all` }], measuredAt: Date.now() });
    setAccountUsage(`claude`, `acc-2`, { windows: [{ kind: `five_hour`, utilization: roomPercent, gates: `all` }], measuredAt: Date.now() });
};

const limitChat = (): Conversation => {
    const conversation = useChat().active.value;
    conversation.restoreMessages([{ role: `user`, text: `clean the sandbox` }]);
    conversation.account.value = `acc-1`;
    conversation.pickUp.value = { reason: `limit`, readyAt: Date.now() + 3_600_000, held: { ran: false } };
    return conversation;
};

it(`offers the other account by name on a spent allowance, and re-runs the held turn on it`, async () => {
    twoAccounts(99, 10);
    const conversation = limitChat();
    const resume = vi.spyOn(conversation, `resumeHeldTurn`).mockResolvedValue(true);
    await mountPanel();

    await openWays();
    const offer = button(`Continue on`);
    expect(offer?.textContent).toContain(`Continue on second`);

    offer?.click();
    await settle();

    expect(conversation.account.value).toBe(`acc-2`);
    expect(resume).toHaveBeenCalledTimes(1);
});

// The common case: one subscription, no second pool to move to.
it(`offers no second account when the only other connection is spent too`, async () => {
    twoAccounts(99, 99);
    limitChat();
    await mountPanel();

    const labels = [...document.querySelectorAll<HTMLButtonElement>(`button`)].map((element) => element.textContent?.trim() ?? ``);
    expect(labels).toContainEqual(expect.stringContaining(`Send it when it's back`));
    expect(button(`Continue on`)).toBeUndefined();
    expect(button(`Auto-continue`)).toEqual(expect.any(Object));
});

it(`keeps the press's variants behind the caret rather than in the row`, async () => {
    twoAccounts(99, 10);
    limitChat();
    await mountPanel();

    expect(button(`Send it when it's back`)).toEqual(expect.any(Object));
    expect(continueButton()).toEqual(expect.any(Object));
    expect(button(`Continue on`)).toBeUndefined();
    expect(button(`Auto-continue`)).toBeUndefined();

    await openWays();

    expect(button(`Continue on`)).toEqual(expect.any(Object));
    expect(button(`Auto-continue`)).toEqual(expect.any(Object));
});

// Anthropic can reopen a spent 5-hour session on demand, once a week, leaving the weekly pool untouched. The offer must
// reflect the provider's own say-so, not a client-side read of the meters.

it(`shows one copy of a checklist restored by failed retries in an older transcript`, async () => {
    const conversation = limitChat();
    const todos = [{ content: `Build the picker`, status: `pending` as const }];
    conversation.restoreMessages([
        { role: `user`, text: `fix the picker` },
        { role: `assistant`, text: ``, todos },
        { role: `notice`, text: `Claude usage limit reached.` },
        { role: `notice`, text: `Sent again after the allowance ran out.` },
        { role: `assistant`, text: ``, todos },
        { role: `notice`, text: `Claude usage limit reached.` },
    ]);
    await mountPanel();
    expect(document.body.textContent?.match(/Build the picker/g)).toHaveLength(1);
    expect(document.body.textContent?.match(/Claude usage limit reached\./g)).toHaveLength(2);
    expect(conversation.messages.value).toHaveLength(6);
});

it(`offers the reset in the row when the provider is granting one, and re-runs the held turn on it`, async () => {
    resetOffer.value = { available: true };
    claimReset.mockResolvedValue({ result: `reset` });
    twoAccounts(99, 10);
    const conversation = limitChat();
    const resume = vi.spyOn(conversation, `resumeHeldTurn`).mockResolvedValue(true);
    await mountPanel();

    const reset = button(`Reset limit now`);
    expect(reset).toEqual(expect.any(Object));
    expect(button(`Auto-continue`)).toBeUndefined();

    reset?.click();
    await settle();

    expect(claimReset).toHaveBeenCalledTimes(1);
    expect(claimReset.mock.calls[0]?.[0]).toBe(`acc-1`);
    expect(resume).toHaveBeenCalledTimes(1);
});

it(`offers no reset when the provider is not granting one, whatever the meters say`, async () => {
    resetOffer.value = { available: false, reason: `already_used` };
    twoAccounts(100, 100);
    limitChat();
    await mountPanel();

    expect(button(`Reset limit now`)).toBeUndefined();
    expect(button(`Send it when it's back`)).toEqual(expect.any(Object));
    expect(button(`Auto-continue`)).toEqual(expect.any(Object));
});

it(`says why nothing happened when a claim changes nothing, and does not re-run the turn`, async () => {
    resetOffer.value = { available: true };
    // Models limitReset.ts's own rule: an answer about the account retires the offer.
    claimReset.mockImplementation(async () => {
        resetOffer.value = undefined;
        return { result: `already_used` };
    });
    twoAccounts(99, 10);
    const conversation = limitChat();
    const resume = vi.spyOn(conversation, `resumeHeldTurn`).mockResolvedValue(true);
    await mountPanel();

    button(`Reset limit now`)?.click();
    await settle();

    expect(button(`Reset limit now`)).toBeUndefined();
    expect(document.querySelector(`.chat-pane`)?.textContent).toContain(`already spent`);
    expect(resume).not.toHaveBeenCalled();
});

it(`keeps the press when the claim never landed, since nothing was spent and nothing was proved`, async () => {
    resetOffer.value = { available: true };
    // Survives an error response too: limitReset.ts keeps the offer when the claim got no real answer.
    claimReset.mockResolvedValue({ result: `error`, detail: `The provider answered 503.` });
    twoAccounts(99, 10);
    limitChat();
    await mountPanel();

    button(`Reset limit now`)?.click();
    await settle();

    expect(button(`Reset limit now`)).toEqual(expect.any(Object));
    expect(document.querySelector(`.chat-pane`)?.textContent).toContain(`503`);
});

// Keeping the session re-reads the whole context on the new account's allowance; a fresh one pays only the hand-off.
it(`offers the other account twice when the session is worth carrying, each with its price, and carries on request`, async () => {
    twoAccounts(99, 10);
    const conversation = limitChat();
    conversation.pickUp.value = {
        reason: `limit`,
        readyAt: Date.now() + 3_600_000,
        held: { ran: true, contextTokens: 85_000, handoffTokens: 6_000 },
    };
    const resume = vi.spyOn(conversation, `resumeHeldTurn`).mockResolvedValue(true);
    await mountPanel();

    await openWays();
    const rows = [...document.querySelectorAll<HTMLButtonElement>(`button`)].filter((element) => element.textContent?.includes(`Continue on second`));
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain(`keeping this session`);
    expect(rows[0]?.textContent).toContain(`85k`);
    expect(rows[1]?.textContent).toContain(`in a fresh session`);
    expect(rows[1]?.textContent).toContain(`6k`);

    rows[0]?.click();
    await settle();
    expect(conversation.account.value).toBe(`acc-2`);
    expect(resume).toHaveBeenCalledWith({ carry: true });
});

it(`offers only the fresh session when nothing ran`, async () => {
    twoAccounts(99, 10);
    const conversation = limitChat();
    conversation.pickUp.value = { reason: `limit`, readyAt: Date.now() + 3_600_000, held: { ran: false, handoffTokens: 6_000 } };
    const resume = vi.spyOn(conversation, `resumeHeldTurn`).mockResolvedValue(true);
    await mountPanel();

    await openWays();
    const rows = [...document.querySelectorAll<HTMLButtonElement>(`button`)].filter((element) => element.textContent?.includes(`Continue on second`));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).not.toContain(`keeping this session`);
    rows[0]?.click();
    await settle();
    expect(resume).toHaveBeenCalledWith({ carry: false });
});

// The appointment's own Stop stays out of this row; showing it here would look like it cancels the wrong thing.
it(`reports a booked move by name and keeps the appointment's control out of the row`, async () => {
    twoAccounts(99, 10);
    const conversation = limitChat();
    conversation.pickUp.value = {
        reason: `limit`,
        readyAt: Date.now() + 3_600_000,
        held: { ran: true, contextTokens: 85_000, moving: `second` },
        automatic: { at: Date.now() },
    };
    await mountPanel();

    expect(composerText()).toContain(`moving to second now`);
    const labels = [...document.querySelectorAll<HTMLButtonElement>(`button`)].map((element) => element.textContent?.trim() ?? ``);
    expect(labels).not.toContainEqual(expect.stringContaining(`Send it when it's back`));
    expect(labels).not.toContainEqual(expect.stringContaining(`Stop`));
});
