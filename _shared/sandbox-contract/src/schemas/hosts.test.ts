import { DevicePingSchema } from "./hosts.js";

const GIB = 1024 ** 3;

// rog on 2026-11-26: Windows at its low line, the VM holding 18.4 GiB, 1.7 GiB of its free memory in blocks under 128 KiB.
const memory = {
    availableBytes: 3.2 * GIB,
    totalBytes: 31.4 * GIB,
    vm: { workingSetBytes: 18.4 * GIB, at: 1_800_000_000_000 },
    guestFree: { reportableBytes: 1.2 * GIB, strandedBytes: 1.7 * GIB, reportingOrder: 5, at: 1_800_000_000_000 },
};

test("a heartbeat from an agent older than the VM's figures still reads, with Windows' own", () => {
    expect(DevicePingSchema.parse({ ok: true, memory: { availableBytes: 3.2 * GIB, totalBytes: 31.4 * GIB } })).toEqual({
        ok: true,
        memory: { availableBytes: 3.2 * GIB, totalBytes: 31.4 * GIB },
    });
});

test("the VM's footprint and the guest's stranded memory ride the heartbeat whole", () => {
    expect(DevicePingSchema.parse({ ok: true, memory })).toEqual({ ok: true, memory });
    const lowered = { ...memory, guestFree: { ...memory.guestFree, reportingOrder: 2, loweredFrom: 5 } };
    expect(DevicePingSchema.parse({ ok: true, memory: lowered }).memory?.guestFree).toEqual(lowered.guestFree);
});

test("a malformed VM figure reads as missing and never costs Windows' own", () => {
    const parsed = DevicePingSchema.parse({
        ok: true,
        memory: { ...memory, vm: { workingSetBytes: -1, at: 1 }, guestFree: { strandedBytes: "lots" } },
    });
    expect(parsed.memory).toEqual({ availableBytes: memory.availableBytes, totalBytes: memory.totalBytes, vm: undefined, guestFree: undefined });
});
