import { checkoutRefusal, checkoutSpace, GIB, historySpaceFloor } from "./checkout-space.js";

test("the history floor clamps two percent to 5–20 GiB", () => {
    expect(historySpaceFloor(100 * GIB)).toBe(5 * GIB);
    expect(historySpaceFloor(250 * GIB)).toBe(5 * GIB);
    expect(historySpaceFloor(500 * GIB)).toBe(10 * GIB);
    expect(historySpaceFloor(1000 * GIB)).toBe(20 * GIB);
    expect(historySpaceFloor(4000 * GIB)).toBe(20 * GIB);
});

test("a checkout may leave exactly the floor, but not one byte less", () => {
    expect(checkoutSpace({ totalBytes: 100 * GIB, freeBytes: 5 * GIB }, 0)).toEqual({ floorBytes: 5 * GIB, allowed: true });
    expect(checkoutSpace({ totalBytes: 100 * GIB, freeBytes: 5 * GIB - 1 }, 0)).toEqual({ floorBytes: 5 * GIB, allowed: false });
    expect(checkoutSpace({ totalBytes: 500 * GIB, freeBytes: 23 * GIB }, 13 * GIB)).toEqual({ floorBytes: 10 * GIB, allowed: true });
    expect(checkoutSpace({ totalBytes: 500 * GIB, freeBytes: 23 * GIB - 1 }, 13 * GIB)).toEqual({ floorBytes: 10 * GIB, allowed: false });
    expect(checkoutSpace({ totalBytes: 4000 * GIB, freeBytes: 80 * GIB }, 13 * GIB)).toEqual({ floorBytes: 20 * GIB, allowed: true });
});

test("the refusal says the measured free space, checkout estimate and recovery", () => {
    expect(checkoutRefusal(3_100_000_000, 13_000_000_000)).toBe(
        "The sandbox's disk has 3.1 GB free, too little to give this conversation its own copy of the workspace (about 13 GB). Free space in Settings → Storage, then send again.",
    );
});
