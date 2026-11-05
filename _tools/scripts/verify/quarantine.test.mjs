// Pins when a failing test leaves the gate's verdict and when it comes back, since a test listed wrongly is a real
// break nobody hears about, and one never released is a test the gate stopped running for good.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
    admit,
    annotations,
    caseOf,
    emptyStore,
    expire,
    fingerprints,
    gateSummary,
    judgeGate,
    MAX_ENTRIES,
    night,
    notePending,
    passedUnits,
    PER_FILE,
    QUARANTINE_DAYS,
    readStore,
    RELEASE_NIGHTS,
    settlePending,
    triage,
    withStore,
} from "./quarantine.mjs";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-05T12:00:00Z");
const TASK = { taskId: "@s/web#test", name: "@s/web", task: "test", directory: "_editor/web" };
const BUILD = { taskId: "@s/web#build", name: "@s/web", task: "build", directory: "_editor/web" };
const unit = (file, name) => `@s/web#test _editor/web/${file} › ${name}`;
const caseNamed = (file, name) => caseOf(unit(file, name), TASK);
const listed = (cases) => admit(emptyStore(), cases, { now: NOW, run: "1/1", reason: "failed, then passed alone" }).store;

test("record: a flaky test case is listed for two weeks with what it is and why", () => {
    const { store, admitted } = admit(emptyStore(), [caseNamed("src/a.test.ts", "outer > waits")], {
        now: NOW,
        run: "9/1",
        reason: "failed, then passed alone",
    });
    assert.equal(admitted.length, 1);
    assert.deepEqual(store.entries[0], {
        unit: unit("src/a.test.ts", "outer > waits"),
        task: "@s/web#test",
        name: "@s/web",
        directory: "_editor/web",
        file: "src/a.test.ts",
        test: "outer > waits",
        since: NOW,
        expires: NOW + QUARANTINE_DAYS * DAY,
        reason: "failed, then passed alone",
        run: "9/1",
        nights: 0,
    });
    assert.equal(
        admit(store, [caseNamed("src/a.test.ts", "outer > waits")], { now: NOW + 1, run: "10/1", reason: "x" }).admitted.length,
        0,
        "listed once",
    );
});

test("record: only test cases, never a file's error between tests or a whole task", () => {
    assert.equal(caseOf(unit("src/a.test.ts", "unhandled error: boom"), TASK), undefined);
    assert.equal(caseOf(unit("src/a.test.ts", "(unnamed)"), TASK), undefined);
    assert.equal(caseOf("@s/web#test", TASK), undefined);
});

test("record: a file holds at most a few listed cases and the list a fixed number", () => {
    const many = Array.from({ length: PER_FILE + 2 }, (_, at) => caseNamed("src/a.test.ts", `case ${at}`));
    const { store, refused } = admit(emptyStore(), many, { now: NOW, run: "1/1", reason: "r" });
    assert.equal(store.entries.length, PER_FILE);
    assert.equal(refused.length, 2);
    assert.match(refused[0].why, /cases of its file/u);
    const full = listed(Array.from({ length: MAX_ENTRIES }, (_, at) => caseNamed(`src/f${at}.test.ts`, "x")));
    const over = admit(full, [caseNamed("src/new.test.ts", "x")], { now: NOW, run: "1/1", reason: "r" });
    assert.equal(over.store.entries.length, MAX_ENTRIES);
    assert.match(over.refused[0].why, /list is full/u);
});

test("skip: a listed case's failure is not counted, anything else is re-run or counted", () => {
    const store = listed([caseNamed("src/a.test.ts", "flaky")]);
    const units = [unit("src/a.test.ts", "flaky"), unit("src/b.test.ts", "new failure"), unit("src/a.test.ts", "unhandled error: x"), "@s/web#build"];
    const triaged = triage(store, [TASK, BUILD], units);
    assert.deepEqual(triaged.tolerated, [unit("src/a.test.ts", "flaky")]);
    assert.deepEqual(triaged.rerun, [unit("src/b.test.ts", "new failure"), unit("src/a.test.ts", "unhandled error: x")]);
    assert.deepEqual(triaged.hard, ["@s/web#build"]);
    assert.equal(triaged.worthRerun, true);
    const wide = Array.from({ length: 6 }, (_, at) => unit(`src/f${at}.test.ts`, "x"));
    assert.equal(triage(emptyStore(), [TASK], wide).worthRerun, false, "six files failing is a break, not a flake");
});

test("skip: the gate passes when every failure is listed or passed alone, and only then", () => {
    const store = listed([caseNamed("src/a.test.ts", "flaky")]);
    const summary = { tasks: [] };
    const tasks = [TASK];
    const noRerun = () => assert.fail("nothing to re-run");
    assert.equal(judgeGate({ store, graphFailed: true, summary, tasks, units: [unit("src/a.test.ts", "flaky")], rerun: noRerun }).ok, true);

    const passesAlone = (units) => ({ flaky: units, still: [] });
    const judged = judgeGate({
        store,
        graphFailed: true,
        summary,
        tasks,
        units: [unit("src/b.test.ts", "load"), unit("src/c.test.ts", "unhandled error: e")],
        rerun: passesAlone,
    });
    assert.equal(judged.ok, true);
    assert.deepEqual(
        judged.flakyCases.map(({ test: name }) => name),
        ["load"],
        "the case is listed",
    );
    assert.deepEqual(judged.fileFlakes, [unit("src/c.test.ts", "unhandled error: e")], "the error between tests is forgiven, not listed");

    const failsAlone = (units) => ({ flaky: [], still: units });
    const real = judgeGate({ store, graphFailed: true, summary, tasks, units: [unit("src/b.test.ts", "broke")], rerun: failsAlone });
    assert.equal(real.ok, false);
    assert.deepEqual(
        real.stillCases.map(({ test: name }) => name),
        ["broke"],
    );

    assert.equal(
        judgeGate({ store, graphFailed: true, summary, tasks: [TASK, BUILD], units: ["@s/web#build"], rerun: passesAlone }).ok,
        false,
        "a build failure",
    );
    assert.equal(judgeGate({ store, graphFailed: true, summary: undefined, tasks: [], units: [], rerun: passesAlone }).ok, false, "nothing read");
    assert.equal(judgeGate({ store, graphFailed: false, summary, tasks: [], units: [], rerun: noRerun }).ok, true);
});

test("expire: an entry comes back after two weeks, and old pending failures are forgotten", () => {
    const store = { ...listed([caseNamed("src/a.test.ts", "x")]), pending: [{ ...caseNamed("src/b.test.ts", "y"), at: NOW, fingerprint: "f" }] };
    assert.equal(expire(store, NOW + QUARANTINE_DAYS * DAY - 1).store.entries.length, 1);
    const later = expire(store, NOW + QUARANTINE_DAYS * DAY);
    assert.equal(later.store.entries.length, 0);
    assert.deepEqual(
        later.expired.map(({ test: name }) => name),
        ["x"],
    );
    assert.equal(later.store.pending.length, 0);
});

test("release: three nights passed in a row release a test, a failure alone evicts it at once", () => {
    let store = listed([caseNamed("src/a.test.ts", "x"), caseNamed("src/b.test.ts", "y"), caseNamed("src/c.test.ts", "z")]);
    const [x, y, z] = store.entries.map((entry) => entry.unit);
    for (let at = 1; at < RELEASE_NIGHTS; at += 1) {
        const result = night(store, new Map([[x, true]]));
        assert.equal(result.released.length, 0);
        store = result.store;
    }
    assert.equal(store.entries.find((entry) => entry.unit === x).nights, RELEASE_NIGHTS - 1);
    const last = night(
        store,
        new Map([
            [x, true],
            [y, false],
        ]),
    );
    assert.deepEqual(
        last.released.map(({ unit: released }) => released),
        [x],
    );
    assert.deepEqual(
        last.evicted.map(({ unit: evicted }) => evicted),
        [y],
    );
    assert.deepEqual(
        last.store.entries.map((entry) => entry.unit),
        [z],
        "a test that did not run keeps its place and count",
    );
});

test("passed later: a main failure is listed when it passes unchanged, and forgotten when what it is built from changed", () => {
    const failing = [caseNamed("src/a.test.ts", "same"), caseNamed("src/b.test.ts", "changed"), caseNamed("src/c.test.ts", "not run")];
    let print = "before";
    const fingerprintOf = () => print;
    const pending = notePending(emptyStore(), failing, { now: NOW, run: "1/1", fingerprintOf });
    assert.equal(pending.pending.length, 3);
    const passed = new Set([failing[0].unit, failing[1].unit]);
    const same = settlePending(pending, passed, { now: NOW + DAY, run: "2/1", fingerprintOf });
    assert.deepEqual(
        same.admitted.map(({ test: name }) => name),
        ["same", "changed"],
    );
    print = "after";
    const changed = settlePending(pending, passed, { now: NOW + DAY, run: "2/1", fingerprintOf });
    assert.equal(changed.admitted.length, 0);
    assert.deepEqual(
        changed.store.pending.map(({ test: name }) => name),
        ["not run"],
    );
});

test("a fingerprint moves with the package's inputs and its dependencies' hashes, not with anything else", () => {
    const summary = (input, dep) => ({
        tasks: [
            { taskId: "@s/web#test", inputs: { "src/a.ts": input }, dependencies: ["@s/base#build"], hashOfExternalDependencies: "e", hash: "x1" },
            { taskId: "@s/base#build", hash: dep },
        ],
    });
    const print = (input, dep) => fingerprints(summary(input, dep))("@s/web#test");
    assert.equal(print("1", "d"), print("1", "d"));
    assert.notEqual(print("1", "d"), print("2", "d"));
    assert.notEqual(print("1", "d"), print("1", "d2"));
    assert.equal(fingerprints(summary("1", "d"))("@s/none#test"), undefined);
});

test("passes are read from the JUnit reports of test tasks that ran, never from a cache hit", () => {
    const xml =
        '<testsuites><testcase file="src/a.test.ts" classname="outer" name="ok"/><testcase file="src/a.test.ts" name="bad"><failure/></testcase><testcase file="src/a.test.ts" name="off"><skipped/></testcase></testsuites>';
    const summary = {
        tasks: [
            { ...TASK, package: "@s/web", cache: { status: "MISS" } },
            { taskId: "@s/api#test", task: "test", package: "@s/api", directory: "_platform/api", cache: { status: "HIT" } },
        ],
    };
    const read = (path) => (path.endsWith("_s_web.unit.xml") ? xml : path.includes("api") ? assert.fail("a cache hit wrote no report") : "");
    assert.deepEqual([...passedUnits(summary, "/j", read)], [unit("src/a.test.ts", "outer > ok")]);
    assert.equal(passedUnits(summary, undefined, read).size, 0);
});

test("the gate run names every listed test as a warning and in its summary", () => {
    const store = listed(Array.from({ length: 12 }, (_, at) => caseNamed(`src/f${at}.test.ts`, `t${at}`)));
    const lines = annotations(store.entries);
    assert.equal(lines.length, 11);
    assert.match(lines[0], /^::warning file=_editor\/web\/src\/f0\.test\.ts,title=quarantined test::t0 \(@s\/web\) is quarantined until 2026-11-19/u);
    assert.match(lines[10], /2 more in the step summary/u);
    const summary = gateSummary({
        store,
        tolerated: [store.entries[0].unit],
        admitted: [],
        refused: [],
        expired: [],
        fileFlakes: [],
        passed: new Set([store.entries[1].unit]),
    });
    assert.match(summary, /Quarantined tests: 12 of at most 50/u);
    assert.match(summary, /\| t0 \| .* \| failed, not counted \|/u);
    assert.match(summary, /\| t1 \| .* \| passed \|/u);
    assert.match(summary, /\| t2 \| .* \| not run \|/u);
});

test("the list is read back as written, and a missing or broken file is an empty list", () => {
    const dir = mkdtempSync(join(tmpdir(), "quarantine-"));
    try {
        const path = join(dir, "nested", "tests.json");
        assert.deepEqual(readStore(path), emptyStore());
        withStore(path, (store) => ({ store: admit(store, [caseNamed("src/a.test.ts", "x")], { now: NOW, run: "1/1", reason: "r" }).store }));
        assert.equal(readStore(path).entries[0].test, "x");
        assert.equal(existsSync(`${path}.lock`), false, "the lock is let go");
        assert.throws(() =>
            withStore(path, () => {
                throw new Error("boom");
            }),
        );
        assert.equal(existsSync(`${path}.lock`), false, "and let go when the change throws");
        assert.equal(readStore(path).entries.length, 1, "a change that threw wrote nothing");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
