// Pins the way back from a turn that stopped, through the real composer and the DOM: the strip and its button,
// Enter-to-continue, and their absence where continuing would be wrong.
import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import { VueQueryPlugin } from "@tanstack/vue-query";
import { type App, computed, createApp, h, nextTick, ref } from "vue";
import type { Conversation } from "../session/conversation";
import { providerAccounts, setAccountUsage } from "../accounts/providerAccounts";
import { CONTINUATIONS } from "../transcript/transcript";
import { useChat } from "../run/useChat";
import { queryClient } from "../../../lib/queryPersistence";
import { SANDBOX_BUSY_AFTER_MS } from "../../sandbox/overview/availability";
import { useLayout } from "../../../shell/window/useLayout";
import { router } from "../../../router";
import ChatPanel from "./ChatPanel.vue";
import { IconStub } from "@intentic/ui/testing";
import * as limitResetOriginal from "../session/limitReset";
import * as useSandboxOriginal from "../../sandbox/client/useSandbox";
import * as useWorkflowRunsOriginal from "../../agents/fleet/useWorkflowRuns";
import * as useSandboxSettingsOriginal from "../../sandbox/overview/useSandboxSettings";

// Import-time globals a mounted chat surface needs.
(() => {
    globalThis.IntersectionObserver ??= class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
    } as unknown as typeof globalThis.IntersectionObserver;
    globalThis.Element.prototype.scrollIntoView = function scrollIntoView(): void {};
})();

// This conversation's own answer for each ending, as the roster carries it, plus the writer the control calls. A ref
// so a test can start from an armed conversation and watch the write go out. Carries the full card shape, not just the
// policies: the tab strip lanes the same entry (agentStatus.laneOf) and reads its attention flags.
const NO_ATTENTION = { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false };
const rosterEntry = (policies: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: `c1`,
    status: `error`,
    attention: { ...NO_ATTENTION },
    ...policies,
});
const { agentEntry, setBreakPolicy, sandboxSettings } = await (async () => {
    const { ref: vueRef } = await import(`vue`);
    return {
        agentEntry: vueRef<Record<string, unknown> | undefined>(undefined),
        setBreakPolicy: jest.fn(),
        sandboxSettings: vueRef<Record<string, unknown> | undefined>({}),
    };
})();
// Fleet roster and workflow ledger the pane queries on mount; irrelevant here beyond the break policy, so answered empty.
jest.mock(`../../agents/fleet/useAgents`, () => {
    return {
        useAgents: () => ({
            fleet: computed(() => []),
            agentById: () => agentEntry.value,
            archived: ref([]),
            loadArchived: () => {},
            restore: () => {},
            busyIds: ref([]),
            setBreakPolicy,
        }),
    };
});
jest.mock(`../../sandbox/overview/useSandboxSettings`, () => ({
    ...useSandboxSettingsOriginal,
    useSandboxSettings: () => ({ settings: sandboxSettings, patch: jest.fn() }),
}));
jest.mock(`../../agents/fleet/useWorkflowRuns`, () => ({
    ...useWorkflowRunsOriginal,
    useWorkflowRuns: () => ({ runs: ref([]), designs: ref([]), start: () => undefined, stop: () => undefined }),
}));
// The composer only renders once the sandbox is reachable; mocked online here, the state this file tests.
const { sandboxReachable, sandboxConnection, ONLINE_CONNECTION } = await (async () => {
    const { ref: vueRef } = await import(`vue`);
    // Steady state for this file: `reachable` alone can't distinguish briefly retrying from down for a while.
    const online = { phase: `online`, failure: undefined, attempt: 0, retryDelayMs: 0, everOnline: true, unavailableSince: undefined, generation: 0 };
    return { sandboxReachable: vueRef(true), sandboxConnection: vueRef({ ...online }), ONLINE_CONNECTION: online };
})();
jest.mock(`../../sandbox/client/useSandbox`, () => {
    const activeSandboxId = ref<string | undefined>(`sandbox-1`);
    const sandboxes = ref([{ id: `sandbox-1`, name: `test` }]);
    return {
        ...useSandboxOriginal,
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
const { resetOffer, claimReset } = await (async () => {
    const { ref: vueRef } = await import(`vue`);
    // A ref, since a claim retiring the offer must repaint the strip.
    return { resetOffer: vueRef<unknown>(undefined), claimReset: jest.fn() };
})();
jest.mock(`../session/limitReset`, () => ({
    ...limitResetOriginal,
    askLimitReset: jest.fn().mockResolvedValue(undefined),
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
// The one question's answers, as the segmented control draws them: role="tab", one selected at a time.
const answerPills = (): HTMLButtonElement[] => [...document.querySelectorAll<HTMLButtonElement>(`.chat-pane button[role="tab"]`)];
const answerPill = (label: string): HTMLButtonElement | undefined => answerPills().find((element) => element.textContent?.trim().startsWith(label));
const armedAnswer = (): string | undefined =>
    answerPills()
        .find((element) => element.getAttribute(`aria-selected`) === `true`)
        ?.textContent?.trim();
const composerText = (): string => document.querySelector(`.chat-pane`)?.textContent ?? ``;
const composer = (): HTMLTextAreaElement => document.querySelector<HTMLTextAreaElement>(`.chat-pane textarea`)!;

// A chat whose last turn stopped, built directly rather than through a failure path, as a starting position for these
// tests.
const stoppedChat = (): Conversation => {
    const chat = useChat();
    const conversation = chat.active.value;
    conversation.transcript.restoreMessages([
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
    resetSandboxScope();
    sandboxReachable.value = true;
    sandboxConnection.value = { ...ONLINE_CONNECTION };
    // `connected` is the composer's own gate; with no account the box goes inert.
    providerAccounts.value = { ...providerAccounts.value, claude: [{ id: `acc-1`, email: `a@b.c` }] as never };
    useLayout().setChatWidth(2000);
    // Baseline: no grant offered, the state every test but the reset tests itself runs in.
    resetOffer.value = undefined;
    claimReset.mockReset();
    // Baseline posture: nothing armed anywhere, which is what every ending ships as.
    agentEntry.value = rosterEntry();
    sandboxSettings.value = {};
    setBreakPolicy.mockReset();
    // Mirrors the real writer's optimistic echo into the roster (useAgents-actions.setBreakPolicy); without it the
    // control would snap back to the old answer and the test would assert a state the app never shows.
    setBreakPolicy.mockImplementation(async (_id: string, ending: string, policy: string | null) => {
        const field = ending === `limit` ? `limitPolicy` : ending === `outage` ? `outagePolicy` : `stopPolicy`;
        agentEntry.value = { ...agentEntry.value, [field]: policy ?? undefined } as Record<string, unknown>;
    });
    await nextTick();
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    providerAccounts.value = { ...providerAccounts.value, claude: [] };
});

it(`offers the stopped turn a way on, and sends the sentence when it is pressed`, async () => {
    const conversation = stoppedChat();
    const say = jest.spyOn(conversation.turn, `say`).mockResolvedValue(undefined);
    await mountPanel();

    expect(composerText()).toContain(`Turn stopped short · work kept`);
    expect(continueButton()?.textContent?.trim()).toBe(`Continue`);

    continueButton()!.click();
    await settle();

    expect(say).toHaveBeenCalledWith(CONTINUATIONS.plain);
});

it(`makes Enter on an empty composer continue, and says so under the box`, async () => {
    const conversation = stoppedChat();
    const say = jest.spyOn(conversation.turn, `say`).mockResolvedValue(undefined);
    await mountPanel();

    expect(composerText()).toContain(`Enter to continue`);
    composer().dispatchEvent(new KeyboardEvent(`keydown`, { key: `Enter`, bubbles: true }));
    await settle();

    expect(say).toHaveBeenCalledWith(CONTINUATIONS.plain);
});

it(`stands down the moment the user types something of their own`, async () => {
    const conversation = stoppedChat();
    const say = jest.spyOn(conversation.turn, `say`).mockResolvedValue(undefined);
    await mountPanel();
    expect(continueButton()).toEqual(expect.any(Object));

    conversation.draft.value = `actually, run the tests first`;
    await settle();

    expect(continueButton()).toBeUndefined();
    expect(composerText()).not.toContain(`stopped`);
    composer().dispatchEvent(new KeyboardEvent(`keydown`, { key: `Enter`, bubbles: true }));
    await settle();
    expect(say).toHaveBeenCalledWith(`actually, run the tests first`, [], undefined);
});

// The question the card exists to ask. One answer is selected at all times, so no state of this card can promise two
// automations over the same wall — the defect this shape replaced, where an "Auto-continue is on, continuing in about
// 244 min" strip stacked under a limit strip still offering to send the turn at that very reset.
it(`asks one question with one answer, and arms it for this conversation alone`, async () => {
    const conversation = stoppedChat();
    conversation.pickUp.value = { reason: `stopped`, held: { ran: true } };
    await mountPanel();

    expect(armedAnswer()).toBe(`Wait for me`);
    answerPill(`Keep trying`)!.click();
    await settle();

    expect(setBreakPolicy).toHaveBeenCalledWith(conversation.conversationId, `stopped`, `retry`);
    expect(armedAnswer()).toBe(`Keep trying`);
});

// A refused write snaps the pill back, which alone is easy to miss: the reader would walk away believing it armed.
it(`keeps the old answer when the write is refused, and says why`, async () => {
    const conversation = stoppedChat();
    conversation.pickUp.value = { reason: `stopped`, held: { ran: true } };
    setBreakPolicy.mockImplementation(async () => {
        throw new Error(`The conversation record is read-only.`);
    });
    await mountPanel();

    answerPill(`Keep trying`)!.click();
    await settle();

    expect(armedAnswer()).toBe(`Wait for me`);
    expect(composerText()).toContain(`The conversation record is read-only.`);
});

// A chat that answers the way the sandbox already does holds no override, rather than a frozen copy of a default it
// would then quietly stop following.
it(`clears the override when the answer is the sandbox's own`, async () => {
    const conversation = stoppedChat();
    conversation.pickUp.value = { reason: `stopped`, held: { ran: true } };
    agentEntry.value = rosterEntry({ stopPolicy: `retry` });
    sandboxSettings.value = { stopPolicy: `retry` };
    await mountPanel();

    expect(armedAnswer()).toBe(`Keep trying`);
    answerPill(`Wait for me`)!.click();
    await settle();

    expect(setBreakPolicy).toHaveBeenCalledWith(conversation.conversationId, `stopped`, `wait`);
});

// One clock, on the line the answer sits on. Nothing counts down while nothing is armed.
it(`counts down only what the chosen answer will actually do`, async () => {
    const conversation = stoppedChat();
    conversation.pickUp.value = { reason: `stopped`, held: { ran: true }, nextAt: Date.now() + 15_000 };
    await mountPanel();

    expect(composerText()).not.toContain(`Goes by itself`);

    agentEntry.value = rosterEntry({ stopPolicy: `retry` });
    await settle();

    expect(composerText()).toContain(`Goes by itself about 15s`);
    // One countdown, not two: the wait is stated on the answer and nowhere else.
    expect(composerText().match(/about 15s/gu)).toHaveLength(1);
});

// The answers are the ending's own; a turn nobody can move has no move to offer.
it(`offers only the answers this ending can take`, async () => {
    const conversation = stoppedChat();
    conversation.pickUp.value = { reason: `stopped`, held: { ran: true } };
    await mountPanel();

    expect(answerPills().map((pill) => pill.textContent?.trim())).toEqual([`Wait for me`, `Keep trying`]);
});

// An unheld allowance means the daemon has no copy of the refused turn, so nothing can be resumed before it resets.
it(`counts an unheld allowance down instead of going quiet, and keeps the press inert until it resets`, async () => {
    const conversation = stoppedChat();
    const say = jest.spyOn(conversation.turn, `say`).mockResolvedValue(undefined);
    conversation.pickUp.value = { reason: `limit`, readyAt: Date.now() + 3_600_000 };
    await mountPanel();

    expect(composerText()).toContain(`Limit reached`);
    expect(composerText()).toContain(`about 60 min`);
    expect(continueButton()?.disabled).toBe(true);
    expect(composerText()).not.toContain(`Enter to continue`);
    composer().dispatchEvent(new KeyboardEvent(`keydown`, { key: `Enter`, bubbles: true }));
    await settle();
    expect(say).not.toHaveBeenCalled();
});

it(`offers a held allowance the press straight away, and re-runs the turn instead of saying anything`, async () => {
    const conversation = stoppedChat();
    const say = jest.spyOn(conversation.turn, `say`).mockResolvedValue(undefined);
    const rerun = jest.spyOn(conversation.turn, `resumeHeldTurn`).mockResolvedValue(true);
    conversation.pickUp.value = { reason: `limit`, readyAt: Date.now() + 8 * 3_600_000, held: { ran: false } };
    await mountPanel();

    expect(composerText()).toContain(`Limit reached · nothing ran · back`);
    expect(composerText()).not.toContain(`work kept`);
    expect(continueButton()?.disabled).toBe(false);
    expect(composerText()).toContain(`Enter to continue`);

    continueButton()!.click();
    await settle();

    expect(rerun).toHaveBeenCalledTimes(1);
    expect(say).not.toHaveBeenCalled();
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
    const say = jest.spyOn(conversation.turn, `say`).mockResolvedValue(undefined);
    conversation.pickUp.value = { reason: `limit`, readyAt: Date.now() - 1_000 };
    await mountPanel();

    expect(continueButton()?.disabled).toBe(false);
    expect(composerText()).toContain(`Enter to continue`);
    continueButton()!.click();
    await settle();

    expect(say).toHaveBeenCalledWith(CONTINUATIONS.plain);
});

// The outage asks the same question in the same words, in the same card: nothing about it is a second shape.
it(`carries the outage in the same card, counting the retry the answer books`, async () => {
    const conversation = stoppedChat();
    conversation.pickUp.value = { reason: `outage`, nextAt: Date.now() + 120_000 };
    agentEntry.value = rosterEntry({ outagePolicy: `retry` });
    await mountPanel();

    expect(composerText()).toContain(`Provider failed · work kept`);
    expect(armedAnswer()).toBe(`Keep trying`);
    expect(composerText()).toContain(`about 2 min`);
    expect(waysButton()).toBeUndefined();
    expect(continueButton()?.disabled).toBe(false);
});

it(`leaves the outage waiting until somebody answers for it`, async () => {
    const conversation = stoppedChat();
    conversation.pickUp.value = { reason: `outage` };
    await mountPanel();

    expect(armedAnswer()).toBe(`Wait for me`);
    expect(composerText()).not.toContain(`Next try`);
    expect(continueButton()?.disabled).toBe(false);
});

it(`says nothing on a chat whose turn finished`, async () => {
    const chat = useChat();
    chat.active.value.transcript.restoreMessages([
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
    conversation.transcript.restoreMessages([{ role: `user`, text: `clean the sandbox` }]);
    conversation.selection.apply({ kind: `set`, picks: { account: `acc-1` } });
    conversation.pickUp.value = { reason: `limit`, readyAt: Date.now() + 3_600_000, held: { ran: false } };
    return conversation;
};

it(`offers the other account by name on a spent allowance, and re-runs the held turn on it`, async () => {
    twoAccounts(99, 10);
    const conversation = limitChat();
    const resume = jest.spyOn(conversation.turn, `resumeHeldTurn`).mockResolvedValue(true);
    await mountPanel();

    await openWays();
    const offer = button(`Continue on`);
    expect(offer?.textContent).toContain(`Continue on second`);

    offer?.click();
    await settle();

    expect(conversation.selection.account.value).toBe(`acc-2`);
    expect(resume).toHaveBeenCalledTimes(1);
});

// The common case: one subscription, no second pool to move to.
it(`offers no second account when the only other connection is spent too`, async () => {
    // Spent is the contract's one line: 99% would still be room to move to.
    twoAccounts(100, 100);
    limitChat();
    await mountPanel();

    // The wait and the resend are always askable; the move is not, with nowhere to move to.
    expect(answerPills().map((pill) => pill.textContent?.trim())).toEqual([`Wait for me`, `Send again`]);
    expect(button(`Continue on`)).toBeUndefined();
});

// The caret holds press VARIANTS only. An automation behind it would be a second place to arm the same thing, which
// is exactly how the old surfaces drifted into saying different things about one conversation.
it(`keeps the press's variants behind the caret, and every automation on the question`, async () => {
    twoAccounts(99, 10);
    limitChat();
    await mountPanel();

    expect(answerPill(`Move to`)).toEqual(expect.any(Object));
    expect(continueButton()).toEqual(expect.any(Object));
    expect(button(`Continue on`)).toBeUndefined();

    await openWays();

    expect(button(`Continue on`)).toEqual(expect.any(Object));
    // The overlay carries no answers: it is two prices for one press.
    expect([...document.querySelectorAll(`button[role="tab"]`)].length).toBe(answerPills().length);
});

// Anthropic can reopen a spent 5-hour session on demand, once a week, leaving the weekly pool untouched. The offer must
// reflect the provider's own say-so, not a client-side read of the meters.

it(`shows one copy of a checklist restored by failed retries in an older transcript`, async () => {
    const conversation = limitChat();
    const todos = [{ content: `Build the picker`, status: `pending` as const }];
    conversation.transcript.restoreMessages([
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
    expect(conversation.transcript.messages.value).toHaveLength(6);
});

it(`offers the reset in the row when the provider is granting one, and re-runs the held turn on it`, async () => {
    resetOffer.value = { available: true };
    claimReset.mockResolvedValue({ result: `reset` });
    twoAccounts(99, 10);
    const conversation = limitChat();
    const resume = jest.spyOn(conversation.turn, `resumeHeldTurn`).mockResolvedValue(true);
    await mountPanel();

    const reset = button(`Reset limit now`);
    expect(reset).toEqual(expect.any(Object));

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
    // The question still stands; only the grant that would remove the wall is missing.
    expect(answerPill(`Send again`)).toEqual(expect.any(Object));
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
    const resume = jest.spyOn(conversation.turn, `resumeHeldTurn`).mockResolvedValue(true);
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
    const resume = jest.spyOn(conversation.turn, `resumeHeldTurn`).mockResolvedValue(true);
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
    expect(conversation.selection.account.value).toBe(`acc-2`);
    expect(resume).toHaveBeenCalledWith({ carry: true });
});

it(`offers only the fresh session when nothing ran`, async () => {
    twoAccounts(99, 10);
    const conversation = limitChat();
    conversation.pickUp.value = { reason: `limit`, readyAt: Date.now() + 3_600_000, held: { ran: false, handoffTokens: 6_000 } };
    const resume = jest.spyOn(conversation.turn, `resumeHeldTurn`).mockResolvedValue(true);
    await mountPanel();

    await openWays();
    const rows = [...document.querySelectorAll<HTMLButtonElement>(`button`)].filter((element) => element.textContent?.includes(`Continue on second`));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).not.toContain(`keeping this session`);
    rows[0]?.click();
    await settle();
    expect(resume).toHaveBeenCalledWith({ carry: false });
});

// A move the owner's policy already booked fires on the next pass, so it names its destination rather than an hour —
// and says so even while the selected answer is `wait`, because it is a fact about the turn, not a plan for it.
it(`reports a booked move by name instead of a countdown`, async () => {
    twoAccounts(99, 10);
    const conversation = limitChat();
    conversation.pickUp.value = {
        reason: `limit`,
        readyAt: Date.now() + 3_600_000,
        held: { ran: true, contextTokens: 85_000, moving: `second` },
    };
    await mountPanel();

    expect(composerText()).toContain(`Moving to second now`);
    expect(composerText()).not.toContain(`Goes by itself`);
});
