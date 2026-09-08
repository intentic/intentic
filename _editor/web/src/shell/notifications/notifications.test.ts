import { describe, expect, it } from "vitest";
import { ref } from "vue";
import { hold, useNotifications } from "./notifications";

// Pins the store's two halves: receipts (imperative; the host owns timing) and held conditions/questions
// (re-derived from source on every read, so "on screen" can't drift from "true").

describe(`receipts`, () => {
    it(`is one channel, not one per caller`, () => {
        const first = useNotifications();
        const second = useNotifications();
        first.say(`Path copied`);
        expect(second.receipt.value?.title).toBe(`Path copied`);
        first.dismissReceipt();
    });

    it(`replaces rather than queues`, () => {
        const { receipt, say, dismissReceipt } = useNotifications();
        say(`1 item deleted`);
        say(`3 items deleted`);
        expect(receipt.value?.title).toBe(`3 items deleted`);
        dismissReceipt();
    });

    it(`gives every raise its own identity, so the dwell restarts`, () => {
        const { receipt, say, dismissReceipt } = useNotifications();
        say(`3 items deleted`);
        const first = receipt.value?.id;
        say(`3 items deleted`);
        expect(receipt.value?.id).not.toBe(first);
        dismissReceipt();
    });

    it(`carries a way back only when the action has one`, () => {
        const { receipt, say, dismissReceipt } = useNotifications();
        say(`Path copied`);
        expect(receipt.value?.actions).toBeUndefined();

        const undo = (): void => {};
        say(`12 agents archived`, undo);
        expect(receipt.value?.actions?.[0]?.label).toBe(`Undo`);
        expect(receipt.value?.actions?.[0]?.run).toBe(undo);
        dismissReceipt();
    });

    it(`clears on dismissal, which is what the host's timer calls`, () => {
        const { receipt, say, dismissReceipt } = useNotifications();
        say(`Token revoked`);
        dismissReceipt();
        expect(receipt.value).toBeUndefined();
    });

    it(`carries the calm failure on the same channel, and never an Undo`, () => {
        const { receipt, warn, dismissReceipt } = useNotifications();
        warn(`Every quick model is out of allowance — couldn't draft a commit message.`);
        expect(receipt.value?.tone).toBe(`problem`);
        expect(receipt.value?.actions).toBeUndefined();
        dismissReceipt();
    });

    it(`lets a completion replace a problem, so the channel is never stale`, () => {
        const { receipt, say, warn, dismissReceipt } = useNotifications();
        warn(`Couldn't draft a commit message.`);
        say(`Path copied`);
        expect(receipt.value?.tone).toBe(`done`);
        dismissReceipt();
    });
});

describe(`held conditions and questions`, () => {
    const titles = (): readonly string[] => useNotifications().notifications.value.map((entry) => entry.title);

    // No raise/remove pair: presence is re-derived from the source every read. The source must return reactive state
    // (ref/computed) for the lane to notice a change.
    it(`is on screen exactly while its source says it is true`, () => {
        const degraded = ref(false);
        const stop = hold(`test:transport`, () => (degraded.value ? { kind: `condition`, title: `Limited connection` } : undefined));
        expect(titles()).not.toContain(`Limited connection`);
        degraded.value = true;
        expect(titles()).toContain(`Limited connection`);
        degraded.value = false;
        expect(titles()).not.toContain(`Limited connection`);
        stop();
    });

    it(`replaces a source registered twice rather than stacking it`, () => {
        const stop = hold(`test:dupe`, () => ({ kind: `condition`, title: `First` }));
        hold(`test:dupe`, () => ({ kind: `condition`, title: `Second` }));
        expect(titles().filter((title) => title === `Second`)).toHaveLength(1);
        expect(titles()).not.toContain(`First`);
        stop();
    });

    // Order is stack position: the lane grows upward from the corner, so the last item sits fixed and the first is
    // the one that moves when height changes.
    it(`orders receipt above condition above question, so nothing shifts under the pointer`, () => {
        const stops = [
            hold(`test:question`, () => ({ kind: `question`, title: `Q` })),
            hold(`test:condition`, () => ({ kind: `condition`, title: `C` })),
        ];
        const { say, dismissReceipt } = useNotifications();
        say(`R`);
        expect(titles()).toEqual([`R`, `C`, `Q`]);
        dismissReceipt();
        for (const stop of stops) {
            stop();
        }
    });

    it(`defaults an unstated tone to info, so a source only says what it means to`, () => {
        const stop = hold(`test:tone`, () => ({ kind: `condition`, title: `Standing fact` }));
        expect(useNotifications().notifications.value.find((entry) => entry.title === `Standing fact`)?.tone).toBe(`info`);
        stop();
    });
});
