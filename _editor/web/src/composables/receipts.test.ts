import { describe, expect, it } from "vitest";
import { useReceipts } from "./receipts";

/* The store's whole contract, which is deliberately small: the timing lives in ReceiptBar.vue because it
 * depends on the pointer (a receipt must not expire under the cursor that came for its Undo), so what is
 * testable here is what a receipt IS and what raising a second one does to the first. */

describe(`useReceipts`, () => {
    it(`is one channel, not one per caller`, () => {
        const first = useReceipts();
        const second = useReceipts();
        first.say(`Path copied`);
        expect(second.receipt.value?.message).toBe(`Path copied`);
        first.dismissReceipt();
    });

    // Newest wins rather than queueing: the second report is always the one the user is looking for, and a
    // queue would make them wait out the first to be told what just happened.
    it(`replaces rather than queues`, () => {
        const { receipt, say, dismissReceipt } = useReceipts();
        say(`1 item deleted`);
        say(`3 items deleted`);
        expect(receipt.value?.message).toBe(`3 items deleted`);
        dismissReceipt();
    });

    it(`carries a way back only when the action has one`, () => {
        const { receipt, say, dismissReceipt } = useReceipts();
        say(`Path copied`);
        expect(receipt.value?.undo).toBeUndefined();

        const undo = (): void => {};
        say(`12 agents archived`, undo);
        expect(receipt.value?.undo).toBe(undo);
        dismissReceipt();
    });

    it(`clears on dismissal, which is what the host's timer calls`, () => {
        const { receipt, say, dismissReceipt } = useReceipts();
        say(`Token revoked`);
        dismissReceipt();
        expect(receipt.value).toBeUndefined();
    });
});
