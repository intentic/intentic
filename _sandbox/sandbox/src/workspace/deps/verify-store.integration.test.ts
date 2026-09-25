import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MainlineRouting, MainlineRun } from "@intentic/sandbox-contract";
import { fileVerifyStore, freshFailures, RUNS_KEPT } from "./verify-store.js";

// What a red names as new decides whether a land is sent back for it, so a standing failure must never read as fresh.

test("a copy of a failure beyond what the last red held is fresh, the held copies are not", () => {
    expect(freshFailures(["a", "a", "b"], ["a"])).toEqual(["a", "b"]);
    expect(freshFailures(["a"], ["a", "a"])).toEqual([]);
});

test("the first red names everything it failed on; the next names only what appeared since; green starts over", async () => {
    const store = fileVerifyStore(join(await mkdtemp(join(tmpdir(), "verify-store-")), "verify.json"));
    // `since` is the streak each verdict belongs to: the one a red starts or extends, and the one a green ends.
    expect(await store.record("app", "red", 1, ["x", "y"])).toEqual({ edge: "broken", attempt: 1, fresh: ["x", "y"], since: 1 });
    expect(await store.record("app", "red", 2, ["x", "y", "z"])).toEqual({ edge: "broken", attempt: 2, fresh: ["z"], since: 1 });
    expect(await store.record("app", "red", 3)).toEqual({ edge: "broken", attempt: 3, since: 1 });
    expect(await store.record("app", "green", 4)).toEqual({ edge: "fixed", attempt: 0, since: 1 });
    expect(await store.record("app", "green", 5)).toEqual({ edge: undefined, attempt: 0 });
    expect(await store.record("app", "red", 6, ["x"])).toEqual({ edge: "broken", attempt: 1, fresh: ["x"], since: 6 });
});

const storeFile = async (): Promise<string> => join(await mkdtemp(join(tmpdir(), "verify-store-")), "verify.json");

// A settled run as the check files it; what each case is about is spelled at its call.
const run = (over: Partial<MainlineRun> & Pick<MainlineRun, "at">): MainlineRun => ({
    project: "app",
    command: "pnpm verify",
    status: "red",
    startedAt: over.at - 100,
    lands: [],
    failures: ["x"],
    failureCount: 1,
    attempt: 1,
    ...over,
});

// A fresh fix-up's id is derived from where its red streak began (landFixConversationId), so one streak is one failure.
test("a red streak keeps the instant it began through every red after it, and green ends it", async () => {
    const path = await storeFile();
    const store = fileVerifyStore(path);
    await store.record("app", "red", 10, ["x"]);
    await store.record("app", "red", 20, ["x", "y"]);
    await store.record("lib", "red", 25);
    expect((await store.read()).projects).toEqual({
        app: { status: "red", attempt: 2, at: 20, failures: ["x", "y"], since: 10 },
        lib: { status: "red", attempt: 1, at: 25, since: 25 },
    });
    // A restart reads the same streak back.
    expect((await fileVerifyStore(path).read()).projects["app"]?.since).toBe(10);

    await store.record("app", "green", 30);
    expect((await store.read()).projects["app"]).toEqual({ status: "green", attempt: 0, at: 30 });
    await store.record("app", "red", 40, ["z"]);
    expect((await store.read()).projects["app"]).toEqual({ status: "red", attempt: 1, at: 40, failures: ["z"], since: 40 });
});

// A file written before the streak was kept names none; its streak is read as starting at the red it has.
test("a red recorded before streaks were kept extends from the instant it was recorded", async () => {
    const path = await storeFile();
    await writeFile(path, JSON.stringify({ projects: { app: { status: "red", attempt: 3, at: 7, failures: ["x"] } } }));
    const store = fileVerifyStore(path);

    expect(await store.read()).toEqual({ projects: { app: { status: "red", attempt: 3, at: 7, failures: ["x"] } }, runs: [] });
    await store.record("app", "red", 8, ["x"]);
    expect((await store.read()).projects["app"]).toEqual({ status: "red", attempt: 4, at: 8, failures: ["x"], since: 7 });
});

test("runs are filed newest first, across projects, and only the latest are kept", async () => {
    const store = fileVerifyStore(await storeFile());
    await store.noteRun(run({ at: 1 }));
    await store.noteRun(run({ at: 2, project: "lib", status: "green", failures: [], failureCount: 0, attempt: 0 }));
    expect((await store.read()).runs.map(({ project, at }) => ({ project, at }))).toEqual([
        { project: "lib", at: 2 },
        { project: "app", at: 1 },
    ]);

    for (let at = 3; at <= RUNS_KEPT + 5; at += 1) {
        await store.noteRun(run({ at }));
    }
    const { runs } = await store.read();
    expect(runs).toHaveLength(RUNS_KEPT);
    expect(runs[0]?.at).toBe(RUNS_KEPT + 5);
    expect(runs.at(-1)?.at).toBe(6);
});

// What became of a red run's failures is decided after the run is filed, sometimes long after (a red held on a
// conversation still working), and lands on that run and no other.
test("a routing lands on the run it answers and replaces what was filed before", async () => {
    const store = fileVerifyStore(await storeFile());
    await store.noteRun(run({ at: 1 }));
    await store.noteRun(run({ at: 1, project: "lib" }));
    await store.noteRun(run({ at: 2 }));
    const waiting: MainlineRouting = { kind: "waiting", at: 3, detail: "More work landed while this ran." };
    const sent: MainlineRouting = { kind: "original", conversationId: "c-1", at: 4 };

    await store.routed("app", 1, waiting);
    await store.routed("app", 1, sent);

    const byRun = (await store.read()).runs.map(({ project, at, routing }) => ({ project, at, routing }));
    expect(byRun).toEqual([
        { project: "app", at: 2, routing: undefined },
        { project: "lib", at: 1, routing: undefined },
        { project: "app", at: 1, routing: sent },
    ]);
});

// Who a red run's failures are laid at is filed as it settles, on every run it answers for, whatever is decided later.
test("blame lands on the runs it answers, says whether it was narrowed, and replaces what was laid before", async () => {
    const store = fileVerifyStore(await storeFile());
    await store.noteRun(run({ at: 1 }));
    await store.noteRun(run({ at: 1, project: "lib" }));
    await store.noteRun(run({ at: 2 }));

    await store.blamed("app", [1, 2], { suspects: ["c-1", "c-2"], named: false });
    await store.blamed("app", [2], { suspects: [], named: false });

    const byRun = (await store.read()).runs.map(({ project, at, suspects, named }) => ({ project, at, suspects, named }));
    expect(byRun).toEqual([
        { project: "app", at: 2, suspects: undefined, named: false },
        { project: "lib", at: 1, suspects: undefined, named: undefined },
        { project: "app", at: 1, suspects: ["c-1", "c-2"], named: false },
    ]);
});

test("a routing or blame for a run that has aged out writes nothing it cannot place", async () => {
    const store = fileVerifyStore(await storeFile());
    await store.noteRun(run({ at: 1 }));
    const resolved: MainlineRouting = { kind: "resolved", at: 2 };

    await store.routed("app", 99, resolved);
    await store.blamed("app", [99], { suspects: ["c-1"], named: true });
    expect((await store.read()).runs[0]).toEqual(run({ at: 1 }));

    await store.routed("app", 1, resolved);
    expect((await store.read()).runs[0]).toEqual({ ...run({ at: 1 }), routing: resolved });
});
