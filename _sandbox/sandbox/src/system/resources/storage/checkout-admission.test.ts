import { reserveCheckoutSpace } from "./checkout-admission.js";
import { GIB } from "./checkout-space.js";

test("concurrent checkouts reserve the available room until their writes finish", async () => {
    const read = async () => ({ freeBytes: 20 * GIB, totalBytes: 100 * GIB });
    const release = await reserveCheckoutSpace("concurrent", 10 * GIB, read);
    try {
        await expect(reserveCheckoutSpace("concurrent", 6 * GIB, read)).rejects.toThrow("too little to give this conversation its own copy");
        const releaseOther = await reserveCheckoutSpace("other-volume", 10 * GIB, read);
        releaseOther();
    } finally {
        release();
    }
    const releaseNext = await reserveCheckoutSpace("concurrent", 10 * GIB, read);
    releaseNext();
});
