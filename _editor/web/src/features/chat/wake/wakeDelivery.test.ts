import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import type { DeliveryHost, WakeConversation } from "./wakeDelivery";

// Pins the moment between words said to the agent and their going: they wait on the card bound where the rule says, go
// by themselves when the moment passes or at once on a press, go to the other place when switched, go nowhere when
// dropped, and what they went to becomes the exchange the next words go on in.

jest.mock(`../../../app/analytics`, () => ({ track: jest.fn(), replaySessionId: () => undefined }));

const { GLANCE_MS, WakeDelivery } = await import(`./wakeDelivery`);

const NOW = 1_800_000_000_000;

const harness = (open: WakeConversation[] = [], focused?: string) => {
    const calls: string[] = [];
    let minted = 0;
    let answers = true;
    const host: DeliveryHost = {
        now: () => NOW,
        lookup: (id) => open.find((conversation) => conversation.id === id),
        focused: () => open.find((conversation) => conversation.id === focused),
        startNew: (text) => {
            minted += 1;
            const id = `new-${minted}`;
            calls.push(`new:${id}:${text}`);
            open.push({ id, title: undefined, asking: false, running: text !== ``, lastSaidAt: undefined });
            return id;
        },
        continueIn: (id, text) => calls.push(`continue:${id}:${text}`),
        answer: (id, text) => {
            calls.push(`answer:${id}:${text}`);
            return answers;
        },
        unclear: () => calls.push(`unclear`),
        expectRequest: () => calls.push(`expect`),
        hold: () => calls.push(`hold`),
        sent: () => calls.push(`sent`),
        dropped: () => calls.push(`dropped`),
        notify: (to) => calls.push(`notify:${to.route.kind}`),
    };
    return {
        delivery: new WakeDelivery(host),
        calls,
        refuseAnswers: () => {
            answers = false;
        },
    };
};

const chat = (id: string, fields: Partial<WakeConversation> = {}): WakeConversation => ({
    id,
    title: `Chat ${id}`,
    asking: false,
    running: false,
    lastSaidAt: undefined,
    ...fields,
});

afterEach(() => {
    jest.useRealTimers();
});

test(`words wait on the card for a moment, then go where it said by themselves`, async () => {
    jest.useFakeTimers();
    const { delivery, calls } = harness();
    delivery.heard({ text: `fix the build`, via: `wake` });
    expect(delivery.pending.value?.to.route).toEqual({ kind: `new`, why: `nothing-recent` });
    expect(calls).toEqual([]);
    await advanceTimersByTimeAsync(GLANCE_MS);
    expect(calls).toEqual([`new:new-1:fix the build`, `hold`, `sent`, `notify:new`]);
    expect(delivery.pending.value).toBeUndefined();
    expect(delivery.sent.value?.id).toBe(`new-1`);
    expect(delivery.thread.value?.id).toBe(`new-1`);
});

test(`a press sends them at once`, () => {
    const { delivery, calls } = harness([chat(`a`, { lastSaidAt: NOW - 60_000 })], `a`);
    delivery.heard({ text: `and add tests`, via: `wake` });
    expect(delivery.pending.value?.to).toEqual({ route: { kind: `continue`, id: `a`, why: `screen` }, title: `Chat a` });
    delivery.sendNow();
    expect(calls[0]).toBe(`continue:a:and add tests`);
});

test(`switched, they go to the other place instead`, () => {
    const { delivery, calls } = harness([chat(`a`, { lastSaidAt: NOW - 60_000 })], `a`);
    delivery.heard({ text: `look at the logs`, via: `wake` });
    delivery.switchRoute();
    expect(delivery.pending.value?.to.route).toEqual({ kind: `new`, why: `asked` });
    expect(delivery.pending.value?.switched).toBe(true);
    delivery.sendNow();
    expect(calls[0]).toBe(`new:new-1:look at the logs`);
});

test(`dropped, they go nowhere`, () => {
    const { delivery, calls } = harness();
    delivery.heard({ text: `never mind`, via: `wake` });
    delivery.cancel();
    expect(calls).toEqual([`dropped`]);
    expect(delivery.pending.value).toBeUndefined();
});

test(`the next words go on in the session the last ones opened`, () => {
    const { delivery, calls } = harness();
    delivery.heard({ text: `fix the build`, via: `wake` });
    delivery.sendNow();
    delivery.heard({ text: `and the lint too`, via: `wake` });
    expect(delivery.pending.value?.to.route).toEqual({ kind: `continue`, id: `new-1`, why: `thread` });
    delivery.sendNow();
    expect(calls).toContain(`continue:new-1:and the lint too`);
});

test(`"new session" alone opens one and takes the next phrase as what goes in it`, () => {
    const { delivery, calls } = harness([chat(`a`, { running: true })], `a`);
    delivery.heard({ text: `new session`, via: `wake` });
    expect(calls).toEqual([`new:new-1:`, `expect`]);
    expect(delivery.pending.value).toBeUndefined();
    delivery.heard({ text: `write the release notes`, via: `called` });
    expect(calls).toContain(`continue:new-1:write the release notes`);
});

test(`words that answer a waiting card answer it; words that do not are said back as unclear`, () => {
    const { delivery, calls, refuseAnswers } = harness([chat(`a`, { asking: true, lastSaidAt: NOW - 30_000 })], `a`);
    delivery.heard({ text: `yes`, via: `following` });
    expect(delivery.pending.value?.to.route).toEqual({ kind: `answer`, id: `a`, why: `screen` });
    delivery.sendNow();
    expect(calls.slice(0, 2)).toEqual([`answer:a:yes`, `hold`]);
    refuseAnswers();
    calls.length = 0;
    delivery.heard({ text: `banana`, via: `following` });
    delivery.sendNow();
    expect(calls).toEqual([`answer:a:banana`, `unclear`]);
});
