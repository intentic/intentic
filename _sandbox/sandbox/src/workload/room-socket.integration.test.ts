import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askFree, askRoom, type MemoryReading } from "@intentic/constants/memory-room";
import { createResourceBudget, type ResourceBudget } from "./resource-budget.js";
import { type RoomSocket, startRoomSocket } from "./room-socket.js";

/* The room socket over a real Unix socket, asked the way queue-run asks it (memory-room): its answer has to be the
   verdict the same budget gives in process, or a heavy command and a turn would be judged by two policies again. */

const GIB = 1024 ** 3;
const box = (limitGib: number, usedGib: number): MemoryReading => ({
    limitBytes: limitGib * GIB,
    usedBytes: usedGib * GIB,
    swapBytes: 0,
    stallPercent: 0,
    oomKills: undefined,
});

const budgetOn = (reading: MemoryReading): ResourceBudget => createResourceBudget({ read: async () => reading, sampleMs: 0, waitIntervalMs: 5 });

let dir: string;
let socket: RoomSocket | undefined;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "room-socket-"));
});

afterEach(async () => {
    await socket?.close();
    socket = undefined;
    await rm(dir, { recursive: true, force: true });
});

const serve = async (budget: ResourceBudget): Promise<string> => {
    const path = join(dir, "room.sock");
    socket = await startRoomSocket(budget, { warn: () => {} }, path);
    return path;
};

test.each([
    ["roomy", box(16, 4)],
    ["short", box(16, 14.5)],
] as const)("on a %s box the socket answers what the budget decides in process", async (_case, reading) => {
    const socketPath = await serve(budgetOn(reading));
    const asked = await askRoom({ workload: "toolchain", waitSeconds: 0, socketPath });
    const inProcess = await budgetOn(reading).admit({ workload: "toolchain", attended: false, where: "local" });
    expect(asked.source).toBe("daemon");
    expect(asked.verdict).toBe(inProcess.verdict);
});

test("an admission over the socket is held in the same ledger as a turn's", async () => {
    const budget = budgetOn(box(16, 12));
    const socketPath = await serve(budget);
    expect((await askRoom({ workload: "toolchain", waitSeconds: 0, socketPath })).verdict).toBe("run");
    expect((await budget.snapshot()).reservedBytes).toBe(GIB);
    expect(await askFree({ socketPath })).toEqual({ freeBytes: 3 * GIB, source: "daemon" });
});

test("a wait asked over the socket is held there until the room comes", async () => {
    let reading = box(16, 15);
    const budget = createResourceBudget({ read: async () => reading, sampleMs: 0, waitIntervalMs: 5, now: (() => {
        let at = 0;
        return () => (at += 1_100);
    })() });
    const socketPath = await serve(budget);
    const asked = askRoom({ workload: "toolchain", waitSeconds: 30, socketPath });
    setTimeout(() => {
        reading = box(16, 4);
    }, 30);
    expect(await asked).toMatchObject({ verdict: "run", source: "daemon" });
});

test("a class the budget does not know is refused, and the caller falls back to the formula", async () => {
    const socketPath = await serve(budgetOn(box(16, 4)));
    // @ts-expect-error: the point is a class no WorkloadClass names.
    const asked = await askRoom({ workload: "spaceship", waitSeconds: 0, socketPath, read: () => box(16, 4) });
    expect(asked.source).toBe("formula");
});
