import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitOut, recordingLogger } from "../../harness/route-fakes.testing.js";
import { filePushChecksStore, type PushChecksState, pushFindingId } from "./push-checks-store.js";
import { createPushChecks, PUSH_REPORT_FILE, watchPushReports } from "./push-checks.js";

// Real git, a real (local, bare) remote and a real recheck script: what this module decides is whether a push reached
// its remote, so that is what runs for real. How the store files a report is push-checks-store.test.ts's.

const roots: string[] = [];
afterEach(async () => {
    for (const dir of roots.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

// No hook of the machine's own may run inside a fixture repository.
const HOOKLESS = ["-c", "core.hooksPath=/dev/null"];

const commit = async (dir: string, name: string, body: string): Promise<string> => {
    await writeFile(join(dir, name), `${body}\n`);
    await gitOut(dir, "add", "-A");
    await gitOut(dir, ...HOOKLESS, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", body);
    return gitOut(dir, "rev-parse", "HEAD");
};

// A workspace holding `app`: `base` already on its origin's main, `head` one commit ahead and not pushed.
const workspace = async (): Promise<{ readonly root: string; readonly app: string; readonly base: string; readonly head: string }> => {
    const root = await mkdtemp(join(tmpdir(), "intentic-push-checks-"));
    roots.push(root);
    const app = join(root, "app");
    await mkdir(app);
    await gitOut(root, "init", "-q", "--bare", "origin.git");
    await gitOut(app, "init", "-q", "-b", "main");
    await gitOut(app, "remote", "add", "origin", join(root, "origin.git"));
    const base = await commit(app, "a.txt", "one");
    await gitOut(app, ...HOOKLESS, "push", "-q", "origin", "main");
    const head = await commit(app, "b.txt", "two");
    return { root, app, base, head };
};

// Where the hook leaves its report: the repository's git common dir, as git names it.
const writeReport = async (app: string, entries: readonly unknown[]): Promise<void> =>
    writeFile(join(await gitOut(app, "rev-parse", "--path-format=absolute", "--git-common-dir"), PUSH_REPORT_FILE), JSON.stringify(entries));

const CATCH = { source: "silent-catch", recheckable: true, gate: "code", text: "src/a.ts:1 empty catch block", key: "src/a.ts:1" } as const;
const RATCHET = { source: "ratchet", recheckable: false, text: "a.test.ts: toEqual became toMatchObject", key: "a.test.ts" } as const;
const RECHECK = ["node", "tools/recheck.mjs", "--recheck"];

const pushEntry = (id: string, at: number, push: { readonly head: string; readonly base: string }, over: Record<string, unknown> = {}) => ({
    version: 1,
    id,
    at,
    kind: "push",
    remote: "origin",
    pushes: [{ ref: "refs/heads/main", head: push.head, base: push.base, commits: 1 }],
    findings: [CATCH, RATCHET],
    recheck: RECHECK,
    ...over,
});

// What the project still owes, by what measured each.
const owedOf = (state: PushChecksState, project: string): string[] => (state.reds[project]?.findings ?? []).map((finding) => finding.source);

test("files a push only once its head is on the remote-tracking ref it moved, and only once", async () => {
    const { root, app, base, head } = await workspace();
    const store = filePushChecksStore(join(root, "push-checks.json"));
    const checks = createPushChecks({ root, store, logger: recordingLogger().logger });
    const at = Date.now();
    await writeReport(app, [pushEntry("p1", at, { head, base })]);

    // The hook has written its report and the push has not landed: nothing yet, and it is looked at again.
    expect(await checks.ingest("app")).toEqual({ changed: false, rechecks: 0, resolved: 0 });
    expect(await store.read()).toEqual({ pushes: [], reds: {}, ended: {}, seen: [] });

    await gitOut(app, ...HOOKLESS, "push", "-q", "origin", "main");

    expect(await checks.ingest("app")).toEqual({ changed: true, rechecks: 0, resolved: 0 });
    const findings = [
        { id: pushFindingId(CATCH), ...CATCH },
        { id: pushFindingId(RATCHET), ...RATCHET },
    ];
    expect(await store.read()).toEqual({
        pushes: [{ project: "app", id: "p1", at, remote: "origin", branch: "main", base, head, commits: 1, findings }],
        reds: { app: { since: at, findings, suspects: [], named: false, decisions: [] } },
        ended: {},
        seen: ["p1"],
    });
    expect(await checks.ingest("app")).toEqual({ changed: false, rechecks: 0, resolved: 0 });
});

test("sets a push the remote never took aside after an hour, and still counts what it measured", async () => {
    const { root, app, base, head } = await workspace();
    const store = filePushChecksStore(join(root, "push-checks.json"));
    const at = Date.now();
    await writeReport(app, [
        pushEntry("p1", at, { head, base }, { findings: [], measured: { checks: { "silent-catch": { ok: true, measured: true, keys: [] } } } }),
        pushEntry("p0", at - 10, { head: base, base }),
    ]);
    const late = createPushChecks({ root, store, logger: recordingLogger().logger, now: () => at + 2 * 60 * 60_000 });

    expect(await late.ingest("app")).toEqual({ changed: true, rechecks: 0, resolved: 1 });
    const state = await store.read();
    expect(owedOf(state, "app")).toEqual(["ratchet"]);
    expect(state.pushes.map((push) => push.id)).toEqual(["p0"]);
    expect(state.seen).toEqual(["p1", "p0"]);
});

test("a recheck runs the newest report's own command in the repository and resolves what it no longer prints", async () => {
    const { root, app, base } = await workspace();
    const store = filePushChecksStore(join(root, "push-checks.json"));
    const checks = createPushChecks({ root, store, logger: recordingLogger().logger });
    await writeReport(app, [pushEntry("p0", Date.now(), { head: base, base })]);
    await checks.ingest("app");
    // What the hook's recheck does, reduced: measure, prepend a recheck entry, and exit non-zero with findings standing.
    await mkdir(join(app, "tools"));
    await writeFile(
        join(app, "tools", "recheck.mjs"),
        [
            `import { readFileSync, writeFileSync } from "node:fs";`,
            `const file = process.argv[3];`,
            `const measured = { checks: { "silent-catch": { ok: true, measured: true, keys: [] } } };`,
            `writeFileSync(file, JSON.stringify([{ version: 1, id: "k1", at: Date.now(), kind: "recheck", measured, recheck: [] }, ...JSON.parse(readFileSync(file, "utf8"))]));`,
            `process.exit(1);`,
        ].join("\n"),
    );
    const report = join(await gitOut(app, "rev-parse", "--path-format=absolute", "--git-common-dir"), PUSH_REPORT_FILE);
    await writeReport(app, [pushEntry("p0", Date.now(), { head: base, base }, { recheck: [...RECHECK, report] })]);

    expect(await checks.recheck("app")).toEqual({ measured: true, resolved: 1, open: 1 });
    expect(owedOf(await store.read(), "app")).toEqual(["ratchet"]);
});

test("a recheck runs nothing but a node script inside the repository", async () => {
    const { root, app, base } = await workspace();
    const store = filePushChecksStore(join(root, "push-checks.json"));
    const checks = createPushChecks({ root, store, logger: recordingLogger().logger });
    const marker = join(root, "ran");
    await writeFile(join(root, "escape.mjs"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "");`);

    for (const recheck of [
        ["node", "../escape.mjs"],
        ["node", join(root, "escape.mjs")],
        ["sh", "-c", `touch ${marker}`],
        ["node", "missing.mjs"],
    ]) {
        await writeReport(app, [pushEntry("p0", Date.now(), { head: base, base }, { recheck })]);
        expect(await checks.recheck("app")).toEqual({ measured: false, resolved: 0, open: 0 });
    }
    expect(
        await access(marker).then(
            () => "ran",
            () => "never ran",
        ),
    ).toBe("never ran");
    expect(await checks.recheck("../app")).toEqual({ measured: false, resolved: 0, open: 0 });
});

test("files every repository's report at boot, the workspace root's included, and each one whose refs move", async () => {
    const asked: string[] = [];
    let moved: ((repos: string[]) => void) | undefined;
    const stop = watchPushReports(
        {
            ingest: async (project) => {
                asked.push(project);
                return { changed: false, rechecks: 0, resolved: 0 };
            },
        },
        {
            refs: (listener) => {
                moved = listener;
                return () => {
                    moved = undefined;
                };
            },
            repos: async () => ["app", "lib/web"],
        },
        recordingLogger().logger,
    );
    await new Promise((settle) => setImmediate(settle));
    moved?.(["root", "app"]);

    expect(asked).toEqual(["", "app", "lib/web", "", "app"]);
    stop();
    expect(moved).toBeUndefined();
});
