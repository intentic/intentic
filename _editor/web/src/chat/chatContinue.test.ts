// @vitest-environment jsdom
//
// THE WAY BACK FROM A TURN THAT STOPPED, asserted through the real composer and read off the DOM, because the
// whole feature is an affordance, and a flag on the conversation that no surface offers is worth nothing.
//
// It comes from the report behind it: a turn ends ("agent did not complete"), or the user declines a tool and
// the agent halts waiting to be told what to do, and the only way on is to type the word "Continue" into the
// box. Every time. The three things that have to be true for that to stop are all here: the strip appears with
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

// The import-time globals a mounted chat surface needs: see chatPanelPanes.test.ts, which explains each.
vi.hoisted(() => {
    globalThis.IntersectionObserver ??= class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
    } as unknown as typeof globalThis.IntersectionObserver;
    globalThis.Element.prototype.scrollIntoView = function scrollIntoView(): void {};
});

// The fleet roster and the workflow ledger, which the pane asks about on mount and neither of which this file
// is about: an empty answer costs nothing and keeps the polling out of it.
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
            setResumeAfterOutage: vi.fn().mockResolvedValue(undefined),
        }),
    };
});
vi.mock(`../composables/agents/useWorkflowRuns`, async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    useWorkflowRuns: () => ({ runs: ref([]), designs: ref([]), start: () => undefined, stop: () => undefined }),
}));
/* THE COMPOSER ONLY EXISTS WHEN THE SANDBOX DOES: unreachable, the whole footer yields to "Chat is available
 * once your sandbox is connected", and every assertion below would pass against a pane with no controls in it
 * at all. So this one is mocked ONLINE: the state the feature lives in. */
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

// A button by the words on it, or nothing: how every affordance here is read off the DOM.
const button = (label: string): HTMLButtonElement | undefined =>
    [...document.querySelectorAll<HTMLButtonElement>(`button`)].find((element) => element.textContent?.trim().startsWith(label));
// The offer, as the DOM has it: the button that carries the word, or nothing.
const continueButton = (): HTMLButtonElement | undefined => button(`Continue`);
// The one hint slot under the box: how anyone learns the key exists.
const composerText = (): string => document.querySelector(`.chat-pane`)?.textContent ?? ``;
const composer = (): HTMLTextAreaElement => document.querySelector<HTMLTextAreaElement>(`.chat-pane textarea`)!;

/* A chat whose last turn stopped before it finished, without going near the network to get there: the pick-up
 * is the state a failed turn LEAVES, and conversation.test.ts is where the failures that leave it are pinned.
 * Here it is a starting position, so this file can be about what the composer does with it. */
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
    // BOTH stores, because a window's tabs live in sessionStorage and only seed from localStorage
    // (windowStore). A stopped turn is persisted with its tab now, so one test's pick-up would otherwise be
    // restored into the next one's chat and every "offers nothing" assertion here would pass or fail on
    // whichever test ran before it.
    localStorage.clear();
    sessionStorage.clear();
    resetChat();
    // `connected` is the composer's own gate: with no account on the provider the box is inert and says so.
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

    expect(composerText()).toContain(`stopped`);
    expect(composerText()).toContain(`finish`);
    // The key is named ON the button, so the reader who has already reached for the mouse learns it anyway.
    expect(continueButton()?.textContent).toContain(`Enter`);

    continueButton()!.click();
    await settle();

    expect(enqueue).toHaveBeenCalledWith(CONTINUATIONS.plain);
});

/* THE WHOLE POINT, in one keystroke. Enter on an empty box did nothing at all before this, so there is no habit
 * being broken, and the hint slot has to say so, because a shortcut nothing advertises is a shortcut only its
 * author uses. */
it(`makes Enter on an empty composer continue, and says so under the box`, async () => {
    const conversation = stoppedChat();
    const enqueue = vi.spyOn(conversation, `enqueue`).mockResolvedValue(undefined);
    await mountPanel();

    expect(composerText()).toContain(`Enter to continue`);
    composer().dispatchEvent(new KeyboardEvent(`keydown`, { key: `Enter`, bubbles: true }));
    await settle();

    expect(enqueue).toHaveBeenCalledWith(CONTINUATIONS.plain);
});

/* WHAT THE OFFER MUST NOT DO. Typing is the user saying what happens next in their own words, so the strip goes
 * and the key goes back to sending the draft: a Continue that fired over a half-written message, or an Enter
 * that sent "continue" instead of what was in the box, would be worse than the typing it replaced. */
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

/* THE STANDING VERSION OF THE PRESS, offered at the moment anyone wishes for it: reading "this turn stopped
 * before it finished" again. Arming it is one click from there, and the strip then says what the chat is doing
 * about itself, because a switch with no readout and no way off is a trap rather than an automation. */
it(`offers to keep continuing by itself, and says so once it is on`, async () => {
    const conversation = stoppedChat();
    await mountPanel();

    const arm = button(`Auto-continue`);
    arm!.click();
    await settle();

    expect(conversation.autoContinue.value).toBe(true);
    expect(composerText()).toContain(`Auto-continue is on`);
    // The offer is not repeated once taken: the armed strip is where the state and the way out of it live now.
    expect(button(`Auto-continue`)).toBeUndefined();
    expect(continueButton()).toEqual(expect.any(Object));

    button(`Turn off`)!.click();
    await settle();
    expect(conversation.autoContinue.value).toBe(false);
    expect(composerText()).not.toContain(`Auto-continue is on`);
});

// The armed line outlives the stop that armed it: switching it on and losing the switch the moment the chat
// moves on would leave an automation nobody can reach.
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

/* A SPENT ALLOWANCE WITH NOTHING HELD: the daemon has no copy of the refused turn (it restarted, or the refusal
 * reached this window without one), so the only way on really is to say something, and saying it before the
 * reset really would just append a message to a chat that cannot answer it. That is the one case the wait still
 * gates, and it is asserted in both halves because either alone is a different bug: the strip has to be UP (so
 * the work is visibly still there and the wait has a length) and the press has to be INERT, key included. */
it(`counts an unheld allowance down instead of going quiet, and keeps the press inert until it resets`, async () => {
    const conversation = stoppedChat();
    const enqueue = vi.spyOn(conversation, `enqueue`).mockResolvedValue(undefined);
    conversation.pickUp.value = { reason: `limit`, readyAt: Date.now() + 3_600_000 };
    await mountPanel();

    expect(composerText()).toContain(`allowance`);
    expect(composerText()).toContain(`about 60 min`);
    expect(continueButton()?.disabled).toBe(true);
    // The key stays what it was: a shortcut that fires into a refusal is worse than no shortcut.
    expect(composerText()).not.toContain(`Enter to continue`);
    composer().dispatchEvent(new KeyboardEvent(`keydown`, { key: `Enter`, bubbles: true }));
    await settle();
    expect(enqueue).not.toHaveBeenCalled();
});

/* THE HELD TURN, WHICH IS WHAT A SPENT ALLOWANCE ORDINARILY LEAVES, and the case that turns the rule above on
 * its head: the press is live with the reset eight hours out, because pressing it re-runs the turn the daemon
 * kept rather than appending anything to the chat.
 *
 * This is the bug's own shape, read back off the DOM. A user looking at a dead button and a countdown does not
 * wait for the countdown; the composer is right there, so they type the word, four times in sixty-five seconds in
 * the transcript this came from, and the fifth got through eight hours before the reset the notice promised. The
 * gate never prevented a request. So the gate is gone where there is nothing left to protect, and the strip says
 * the honest thing instead of the confident one: this never ran, and the reset is a due date rather than a wall. */
it(`offers a held allowance the press straight away, and re-runs the turn instead of saying anything`, async () => {
    const conversation = stoppedChat();
    const enqueue = vi.spyOn(conversation, `enqueue`).mockResolvedValue(undefined);
    const rerun = vi.spyOn(conversation, `resumeHeldTurn`).mockResolvedValue(true);
    conversation.pickUp.value = { reason: `limit`, readyAt: Date.now() + 8 * 3_600_000, held: { ran: false } };
    await mountPanel();

    // No claim that work survives a turn that never started, and no wall in front of the press.
    expect(composerText()).toContain(`allowance`);
    expect(composerText()).toContain(`never ran`);
    expect(composerText()).not.toContain(`work so far`);
    expect(continueButton()?.disabled).toBe(false);
    expect(composerText()).toContain(`Enter to continue`);

    continueButton()!.click();
    await settle();

    expect(rerun).toHaveBeenCalledTimes(1);
    // The whole point: nothing was said. A message here is the pile this replaces, one row per press.
    expect(enqueue).not.toHaveBeenCalled();
});

/* A limit reached IN FLIGHT is held too, and it is the one that may honestly claim the work. Same press, same
 * lack of a gate, different sentence, because a model told to carry on from work that never happened invents
 * some (RESUME_NOTES.refused vs .limit), and a reader told the same is simply misinformed. */
it(`tells a mid-turn allowance failure apart from one that refused the turn outright`, async () => {
    const conversation = stoppedChat();
    conversation.pickUp.value = { reason: `limit`, readyAt: Date.now() + 3_600_000, held: { ran: true } };
    await mountPanel();

    expect(composerText()).toContain(`allowance`);
    expect(composerText()).toContain(`work so far`);
    expect(continueButton()?.disabled).toBe(false);
});

// ...and on the far side of the reset it is an ordinary stopped turn, with the ordinary press and the key back.
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

/* THE OUTAGE, IN THE SAME STRIP. It used to be a banner of its own in another component, which is how one
 * situation, a turn that stopped with work behind it, came to look like three unrelated things depending on
 * what stopped it. What it keeps that the others don't is the second party: the daemon's breaker is already
 * retrying, so the strip reports that wait and offers the way out of it, and the manual press stays live for
 * anyone who won't wait. */
it(`carries the outage in the same strip, with the way out of its automatic retry`, async () => {
    const conversation = stoppedChat();
    conversation.pickUp.value = { reason: `outage`, automatic: { at: Date.now() + 120_000 } };
    await mountPanel();

    expect(composerText()).toContain(`2 min`);
    expect(composerText()).toContain(`Stop`);
    // Nothing offers to arm a SECOND automation over a turn something is already bringing back.
    expect(button(`Auto-continue`)).toBeUndefined();
    expect(continueButton()?.disabled).toBe(false);
});

// The same outage with nothing retrying it: the strip becomes the offer to arm the daemon's own resume, beside
// the press that does it now.
it(`offers to keep the chat going when nothing is retrying the outage`, async () => {
    const conversation = stoppedChat();
    conversation.pickUp.value = { reason: `outage` };
    await mountPanel();

    expect(button(`Keep this chat going`)).toEqual(expect.any(Object));
    expect(continueButton()?.disabled).toBe(false);
});

// A chat that ended cleanly is not offered anything: the strip is for work left hanging, and one that showed up
// after every finished answer would be noise the reader learns to look past: including on the turns it matters.
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
