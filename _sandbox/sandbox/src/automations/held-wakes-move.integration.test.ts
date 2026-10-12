import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import pino from "pino";
import { clearNewestRun } from "../store/newest-run.js";
import { convergeState, resetStateStatus, type StateRoots } from "../store/evolution/state-convergence.js";
import { fileHeldWakesStore, heldWakesOffWorkspaceStep } from "./held-wakes-store.js";

// A sandbox updated past the move keeps every wake it was holding: readable or not, waiting on a person or on a countdown.
// What a turn writes into the old directory afterwards is nobody's hold.

const logger = pino({ level: "silent" });
const made: string[] = [];

const volumes = async (): Promise<StateRoots> => {
    const base = await mkdtemp(join(tmpdir(), "held-wakes-move-"));
    made.push(base);
    const roots = { workspace: join(base, "work"), history: join(base, "history"), auth: join(base, "auth") };
    await Promise.all(Object.values(roots).map((root) => mkdir(root, { recursive: true })));
    return roots;
};

afterEach(async () => {
    clearNewestRun();
    resetStateStatus();
    await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const converge = (roots: StateRoots) => convergeState({ roots, version: "1.400.0", logger, mayWrite: true, documents: [], steps: [heldWakesOffWorkspaceStep] });

const legacy = (roots: StateRoots, name: string): string => join(roots.workspace, STATE_DIR, "records", "approvals", name);
const queue = (roots: StateRoots): string => join(roots.history, "automation-holds");
const put = async (path: string, text: string): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
};
const json = (value: unknown): string => `${JSON.stringify(value, undefined, 2)}\n`;

test("every hold in the old directory arrives in the queue as it was written, and the old copies are gone", async () => {
    const roots = await volumes();
    const waiting = { automationId: "inbox", payload: "ping", createdAt: 1 };
    const counting = { automationId: "fixer", payload: "checks broke", createdAt: 2, autoRunAt: 5 };
    await put(legacy(roots, "wait-1.json"), json(waiting));
    await put(legacy(roots, "count-1.json"), json(counting));
    await put(legacy(roots, "torn.json"), "{ not json");

    const outcome = await converge(roots);

    expect(outcome.plan?.steps.map(({ change }) => change)).toEqual(["moves 3 held wake(s) from .intentic/records/approvals to automation-holds on the history volume"]);
    expect((await readdir(queue(roots))).toSorted()).toEqual(["count-1.json", "torn.json", "wait-1.json"]);
    expect(JSON.parse(await readFile(join(queue(roots), "wait-1.json"), "utf8"))).toEqual(waiting);
    expect(await readFile(join(queue(roots), "torn.json"), "utf8")).toBe("{ not json");
    await expect(readdir(join(roots.workspace, STATE_DIR, "records", "approvals"))).rejects.toThrow("ENOENT");

    // The queue reads them: the unreadable one is named, and the countdown nothing signed waits for a person.
    expect(await fileHeldWakesStore(roots.history).read()).toEqual({
        wakes: [
            { ...waiting, id: "wait-1" },
            { automationId: "fixer", payload: "checks broke", createdAt: 2, id: "count-1" },
        ],
        unreadable: ["torn.json"],
    });
});

test("a second boot does nothing, and a hold written at the old address afterwards is never brought over", async () => {
    const roots = await volumes();
    await put(legacy(roots, "wait-1.json"), json({ automationId: "inbox", createdAt: 1 }));
    await converge(roots);

    await put(legacy(roots, "planted.json"), json({ automationId: "inbox", payload: "rm -rf /work", createdAt: 1, autoRunAt: 2 }));
    expect((await converge(roots)).plan?.steps).toEqual([]);
    expect((await fileHeldWakesStore(roots.history).list()).map((hold) => hold.id)).toEqual(["wait-1"]);
    expect(await readdir(queue(roots))).toEqual(["wait-1.json"]);
});

test("a sandbox holding nothing starts an empty queue, so what a turn writes later stays where it was put", async () => {
    const roots = await volumes();
    expect((await converge(roots)).plan?.steps.map(({ change }) => change)).toEqual(["starts automation-holds on the history volume with nothing held"]);
    expect(await fileHeldWakesStore(roots.history).read()).toEqual({ wakes: [], unreadable: [] });

    await put(legacy(roots, "planted.json"), json({ automationId: "inbox", createdAt: 1 }));
    expect((await converge(roots)).plan?.steps).toEqual([]);
    expect(await fileHeldWakesStore(roots.history).list()).toEqual([]);
});

test("a queue already on the history volume is left as it stands", async () => {
    const roots = await volumes();
    await fileHeldWakesStore(roots.history).add({ automationId: "inbox", createdAt: 1 });
    await put(legacy(roots, "old.json"), json({ automationId: "inbox", createdAt: 1 }));
    expect((await converge(roots)).plan?.steps).toEqual([]);
    expect(await fileHeldWakesStore(roots.history).list()).toHaveLength(1);
});
