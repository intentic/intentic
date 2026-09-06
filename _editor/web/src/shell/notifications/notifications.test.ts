import { describe, expect, it } from "vitest";
import { ref } from "vue";
import { hold, useNotifications } from "./notifications";

/* The store's whole contract. Two halves, tested as two things, because they are two things:
 *
 * The RECEIPT half is imperative and deliberately tiny — the timing lives in NotificationHost.vue, since it
 * depends on the pointer (a receipt must not expire under the cursor that came for its Undo), so what is
 * testable here is what a receipt IS and what raising a second one does to the first.
 *
 * The HELD half is the one that replaced six components. What matters about it is that a card's presence is not
 * a thing anyone can set: it is re-derived from the source on every read, which is the property that makes "on
 * screen" and "true" impossible to drift apart. */

describe(`receipts`, () => {
    it(`is one channel, not one per caller`, () => {
        const first = useNotifications();
        const second = useNotifications();
        first.say(`Path copied`);
        expect(second.receipt.value?.title).toBe(`Path copied`);
        first.dismissReceipt();
    });

    // Newest wins rather than queueing: the second report is always the one the user is looking for, and a
    // queue would make them wait out the first to be told what just happened.
    it(`replaces rather than queues`, () => {
        const { receipt, say, dismissReceipt } = useNotifications();
        say(`1 item deleted`);
        say(`3 items deleted`);
        expect(receipt.value?.title).toBe(`3 items deleted`);
        dismissReceipt();
    });

    // A new identity per raise, even for the same sentence: it is what re-arms the host's dwell rather than
    // letting the second report inherit the tail of the first.
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

    // The third thing that can happen: not done, not alarming. It rides the same card so that a helper which
    // could not answer stops reaching the user as a click that did nothing at all.
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

    /* The contract, and the reason there is no `raise`/`remove` pair for these: the card's presence is not a
     * thing any caller sets, it is re-derived from the source, so "on screen" and "true" cannot drift apart.
     * The source has to read REACTIVE state for the lane to notice a change — which every real one does, since
     * each is a ref or a computed on a module-scoped store. */
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

    // Registering the same id twice replaces it. A runtime that mounts a second time is idempotent rather than
    // doubled, which is the failure the old per-component notices could not have: they had a `v-if` instead.
    it(`replaces a source registered twice rather than stacking it`, () => {
        const stop = hold(`test:dupe`, () => ({ kind: `condition`, title: `First` }));
        hold(`test:dupe`, () => ({ kind: `condition`, title: `Second` }));
        expect(titles().filter((title) => title === `Second`)).toHaveLength(1);
        expect(titles()).not.toContain(`First`);
        stop();
    });

    /* THE STACK'S ORDER, which is geometry rather than severity: the lane is anchored to the bottom of the
     * viewport and grows upward, so the LAST item is the one in the corner and the FIRST is the one that moves
     * when the stack changes height. A receipt appears and vanishes several times a minute, so it goes on top
     * where it can do that without shifting anything; a question is the one thing here the user still owes, so
     * it takes the corner, which is the position that never moves. */
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
