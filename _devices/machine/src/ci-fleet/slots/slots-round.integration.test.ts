import { exec, fakeSys, tempDir, testConfig, testContext } from "../ci-fleet-testing.js";
import { SHRINK_AFTER_MS, SLOT_BYTES } from "./decide.js";
import { sandboxIds, sizeBytes, usedBytes } from "./sandbox-memory.js";
import { SlotsConfigSchema } from "./slots-config.js";
import type { SlotLock, TakeLock } from "./slot-lock.js";
import { createSlotHolder, startSlots } from "./slots.js";

/* The holder's looks on a fake computer and fake locks: what Docker says becomes slots held, a slot CI holds is skipped
   and taken once free, a dead child is taken again, a Docker that fails keeps what is held, and a holder switched off
   holds and reports nothing. */

test("docker's sizes are read in its own units", () => {
    expect(sizeBytes("1.5GiB")).toBe(1.5 * 1024 ** 3);
    expect(sizeBytes("512MiB")).toBe(512 * 1024 ** 2);
    expect(sizeBytes("2kB")).toBe(2000);
    expect(sizeBytes("0B")).toBe(0);
    expect(sizeBytes("--")).toBeUndefined();
    expect(sandboxIds("aaa sandbox\nbbb egress-helper\nccc runner\nddd \n")).toEqual(["aaa", "ccc"]);
    expect(usedBytes("aaa   1GiB / 31.2GiB\nccc 512MiB / 31.2GiB\nddd -- / --\n")).toBe(1.5 * 1024 ** 3);
});

// Locks as a map of path → alive, with `busy` paths someone else holds.
const fakeLocks = () => {
    const live = new Map<string, { alive: boolean }>();
    const busy = new Set<string>();
    const take: TakeLock = async (path) => {
        if (busy.has(path) || live.get(path)?.alive === true) {
            return await Promise.resolve(undefined);
        }
        const entry = { alive: true };
        live.set(path, entry);
        const lock: SlotLock = {
            pid: 1,
            alive: () => entry.alive,
            release: async () => {
                entry.alive = false;
                await Promise.resolve();
            },
        };
        return lock;
    };
    return { take, live, busy };
};

// What Docker says the sandboxes use, or that it does not answer.
interface Memory {
    bytes: number | "down";
}

const computer = (memory: Memory) =>
    fakeSys({
        programs: (command, args) => {
            if (command !== "docker" || memory.bytes === "down") {
                return undefined;
            }
            return args[0] === "ps" ? exec("abc sandbox\n") : exec(`abc ${memory.bytes}B / 32GiB\n`);
        },
    });

const holderOn = async (memory: Memory, slots: object = {}) => {
    const sys = computer(memory);
    const dir = tempDir("ci-slots-");
    const { context, lines } = await testContext(sys, testConfig({ slots: SlotsConfigSchema.parse({ dir, ...slots }) }));
    const locks = fakeLocks();
    return { sys, dir, context, lines, locks, holder: createSlotHolder(context, locks.take) };
};

test("the sandboxes' memory is held as slots from the top, and reported", async () => {
    const memory = { bytes: 0.5 * SLOT_BYTES };
    const { holder, context } = await holderOn(memory, { usable: 9 });
    await holder.look();
    // usable 9 keeps a floor of 7, and half a GiB of sandboxes takes one more.
    expect(holder.held()).toEqual([16, 15, 14, 13, 12, 11, 10, 9]);
    expect(context.status.read().slots).toMatchObject({ total: 16, reserved: 6, floor: 7, heldForSandboxes: 8, sandboxBytes: 0.5 * SLOT_BYTES, heldByCi: 0, free: 8 });
    // However much more they use, never one of the gate band.
    memory.bytes = 40 * SLOT_BYTES;
    await holder.look();
    expect(holder.held()).toEqual([16, 15, 14, 13, 12, 11, 10, 9, 8, 7]);
    await holder.stop();
});

test("a slot CI holds is skipped and taken once it frees", async () => {
    const { holder, dir, locks } = await holderOn({ bytes: 3 * SLOT_BYTES });
    locks.busy.add(`${dir}/slot-15`);
    await holder.look();
    expect(holder.held()).toEqual([16, 14]);
    locks.busy.clear();
    await holder.look();
    expect(holder.held()).toEqual([16, 15, 14]);
    await holder.stop();
});

test("a smaller need is believed after two minutes, and the lowest slots go back first", async () => {
    const memory = { bytes: 4 * SLOT_BYTES };
    const { holder, sys } = await holderOn(memory);
    await holder.look();
    expect(holder.held()).toEqual([16, 15, 14, 13]);
    memory.bytes = SLOT_BYTES;
    sys.computer.now = 0;
    await holder.look();
    expect(holder.held()).toEqual([16, 15, 14, 13]);
    sys.computer.now = SHRINK_AFTER_MS;
    await holder.look();
    expect(holder.held()).toEqual([16]);
    await holder.stop();
});

test("a holder child that died is noticed and its slot taken again", async () => {
    const { holder, dir, locks, lines } = await holderOn({ bytes: 2 * SLOT_BYTES });
    await holder.look();
    const entry = locks.live.get(`${dir}/slot-16`);
    if (entry !== undefined) {
        entry.alive = false;
    }
    await holder.look();
    expect(holder.held()).toEqual([16, 15]);
    expect(locks.live.get(`${dir}/slot-16`)?.alive).toBe(true);
    expect(lines.some((line) => line.includes("slot 16 died"))).toBe(true);
    await holder.stop();
});

test("a docker that fails keeps what is held and says so once", async () => {
    const memory: Memory = { bytes: 2 * SLOT_BYTES };
    const { holder, lines, sys } = await holderOn(memory);
    await holder.look();
    memory.bytes = "down";
    sys.computer.now = 10 * SHRINK_AFTER_MS;
    await holder.look();
    await holder.look();
    expect(holder.held()).toEqual([16, 15]);
    expect(lines.filter((line) => line.includes("could not measure"))).toHaveLength(1);
    await holder.stop();
    expect(holder.held()).toEqual([]);
});

test("a holder switched off holds and reports nothing", async () => {
    const sys = computer({ bytes: 8 * SLOT_BYTES });
    const { context } = await testContext(sys, testConfig({ slots: SlotsConfigSchema.parse({ enabled: false, dir: tempDir() }) }));
    const locks = fakeLocks();
    const rounds = startSlots(context, locks.take);
    rounds.stop();
    expect(locks.live.size).toBe(0);
    expect(sys.calls).toEqual([]);
    expect(context.status.read().slots).toBeUndefined();
});
