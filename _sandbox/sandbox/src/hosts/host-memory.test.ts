import { HOST_MEMORY_STALE_MS, hostRoomFrom } from "./host-memory.js";

const GIB = 1024 ** 3;
const NOW = 1_800_000_000_000;
const memory = { availableBytes: 1.1 * GIB, totalBytes: 32 * GIB };

// The hub's last heartbeat per door, as the test states it.
const beats =
    (table: Record<string, { readonly at: number; readonly answer: unknown }>) =>
    (door: string): { readonly at: number; readonly answer: unknown } | undefined =>
        table[door];

test("the door running the sandbox says what its machine has, with the reserve both sides keep", () => {
    expect(hostRoomFrom("rog", beats({ rog: { at: NOW - 30_000, answer: { ok: true, memory } } }), NOW)).toEqual({
        name: "rog",
        ...memory,
        // A tenth of 32 GiB is more than the 1.5 GiB floor.
        reserveBytes: 3.2 * GIB,
    });
});

// A distro's agent reads the VM, not Windows, so it never says; its PC's Windows side does.
test("a distro's door answers with its machine's Windows side", () => {
    const table = beats({ "rog::wsl:Ubuntu": { at: NOW, answer: { ok: true } }, rog: { at: NOW, answer: { ok: true, memory } } });
    expect(hostRoomFrom("rog::wsl:Ubuntu", table, NOW)).toMatchObject({ name: "rog", availableBytes: memory.availableBytes });
});

test("no machine, a stale answer, an older agent or an answer that does not parse is no host constraint", () => {
    expect(hostRoomFrom(undefined, beats({ rog: { at: NOW, answer: { ok: true, memory } } }), NOW)).toBeUndefined();
    expect(hostRoomFrom("rog", beats({ rog: { at: NOW - HOST_MEMORY_STALE_MS - 1, answer: { ok: true, memory } } }), NOW)).toBeUndefined();
    expect(hostRoomFrom("rog", beats({ rog: { at: NOW, answer: { ok: true } } }), NOW)).toBeUndefined();
    expect(hostRoomFrom("rog", beats({ rog: { at: NOW, answer: { ok: true, memory: { availableBytes: "lots" } } } }), NOW)).toBeUndefined();
    expect(hostRoomFrom("rog", beats({}), NOW)).toBeUndefined();
});
