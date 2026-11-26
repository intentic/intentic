import { HOST_MEMORY_STALE_MS, hostAnswering, hostRoomFrom } from "./host-room.js";

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

// Whether a runner's machine is awake, whatever its heartbeat said: what tells a runner down on an awake machine from one
// asleep with it (runners/held-turns/runner-relay.ts).
test("a machine whose agent answered lately is awake, on the runner's own door or its card's native one", () => {
    const ok = { ok: true };
    expect(hostAnswering("omen", beats({ omen: { at: NOW - 10_000, answer: ok } }), NOW)).toBe(true);
    expect(hostAnswering("omen::wsl:archlinux", beats({ omen: { at: NOW - 10_000, answer: ok } }), NOW)).toBe(true);
});

test("a heartbeat older than the stale line, none at all, or no machine named is not awake", () => {
    expect(hostAnswering("omen", beats({ omen: { at: NOW - HOST_MEMORY_STALE_MS - 1, answer: { ok: true } } }), NOW)).toBe(false);
    expect(hostAnswering("omen", beats({}), NOW)).toBe(false);
    expect(hostAnswering(undefined, beats({ omen: { at: NOW, answer: { ok: true } } }), NOW)).toBe(false);
});

// (2026-11-26) What the composer names as holding the memory: the WSL VM's footprint and its unused, stranded part, as
// the Windows side read them; and the part of its free memory already handed back, which the room gate charges. A VM that is not running reads 0, which says nothing about the one this sandbox is in.
test("the WSL VM's share and its unused part ride along where the agent read them", () => {
    const vm = { workingSetBytes: 16.6 * GIB, at: NOW - 60_000 };
    const guestFree = { reportableBytes: 0.4 * GIB, strandedBytes: 3.5 * GIB, reportingOrder: 5, at: NOW - 60_000 };
    expect(hostRoomFrom("rog", beats({ rog: { at: NOW, answer: { ok: true, memory: { ...memory, vm, guestFree } } } }), NOW)).toEqual({
        name: "rog",
        ...memory,
        reserveBytes: 3.2 * GIB,
        vmBytes: 16.6 * GIB,
        vmUnusedBytes: 3.5 * GIB,
        // All the room gate charges work inside the VM against Windows (@intentic/constants heavy/host-short.mjs).
        vmReportableBytes: 0.4 * GIB,
    });
    const stopped = hostRoomFrom("rog", beats({ rog: { at: NOW, answer: { ok: true, memory: { ...memory, vm: { workingSetBytes: 0, at: NOW } } } } }), NOW);
    expect(stopped).toEqual({ name: "rog", ...memory, reserveBytes: 3.2 * GIB });
});
