import { statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { readHistorySpace, reserveCheckoutSpace } from "./checkout-admission.js";
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

test("a conversation told of the floor goes past it next time, until a reading has room again", async () => {
    let freeBytes = 7 * GIB;
    const read = async () => ({ freeBytes, totalBytes: 1000 * GIB });
    await expect(reserveCheckoutSpace("told", GIB, read, "c1")).rejects.toThrow("The sandbox's disk has 7.5 GB free");
    await expect(reserveCheckoutSpace("told", GIB, read, "c2")).rejects.toThrow("The sandbox's disk has 7.5 GB free");
    (await reserveCheckoutSpace("told", GIB, read, "c1"))();
    await expect(reserveCheckoutSpace("told", GIB, read, "c1-elsewhere")).rejects.toThrow("too little");
    freeBytes = 100 * GIB;
    (await reserveCheckoutSpace("told", GIB, read, "c1"))();
    freeBytes = 7 * GIB;
    await expect(reserveCheckoutSpace("told", GIB, read, "c1")).rejects.toThrow("The sandbox's disk has 7.5 GB free");
});

test("a warning already given never lets through a checkout the disk cannot hold", async () => {
    const read = async () => ({ freeBytes: 2 * GIB, totalBytes: 1000 * GIB });
    await expect(reserveCheckoutSpace("full", 3 * GIB, read, "c1")).rejects.toThrow("too little");
    await expect(reserveCheckoutSpace("full", 3 * GIB, read, "c1")).rejects.toThrow("The sandbox's disk has 2.1 GB free");
    await expect(reserveCheckoutSpace("unowned", GIB, read)).rejects.toThrow("too little");
    await expect(reserveCheckoutSpace("unowned", GIB, read)).rejects.toThrow("too little");
});

test("a root daemon counts the filesystem's reserved blocks as free, any other writer only the available ones", async () => {
    const volume = await statfs(tmpdir());
    expect(await readHistorySpace(tmpdir(), true)).toEqual({ freeBytes: volume.bfree * volume.bsize, totalBytes: volume.blocks * volume.bsize });
    expect(await readHistorySpace(tmpdir(), false)).toEqual({ freeBytes: volume.bavail * volume.bsize, totalBytes: volume.blocks * volume.bsize });
});
