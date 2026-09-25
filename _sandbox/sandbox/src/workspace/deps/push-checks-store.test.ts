import {
    applyMeasured,
    dismissIn,
    fileRefusal,
    REFUSAL_SOURCE,
    settleRefusals,
    ingestMeasurement,
    ingestPush,
    parsePushReport,
    PUSHES_CAP,
    PUSHES_KEPT,
    pushFindingId,
    type PushChecksState,
    type PushReportEntry,
    retained,
    SEEN_KEPT,
    type StoredPush,
} from "./push-checks-store.js";

// What the pre-push hook let through, as the store files it: a finding stays open until a later measurement no longer
// prints it or somebody dismisses it. The file around it (jsonFile) and the report's discovery are
// push-checks.integration.test.ts's.

const EMPTY: PushChecksState = { pushes: [], seen: [] };

const CATCH = {
    kind: "check",
    check: "silent-catch",
    gate: "code",
    text: "src/a.ts:1 empty catch block",
    key: "src/a.ts:1 silent catch",
    command: "node _tools/checks/run.mjs --only silent-catch",
} as const;
const LINT = { kind: "lint", text: "src/b.ts:4 no-unused-vars", key: "", command: "node _tools/oxlint/lint-edit.mjs src/b.ts" } as const;
const RATCHET = {
    kind: "ratchet",
    text: "tests/a.test.ts: toEqual became toMatchObject",
    key: "tests/a.test.ts",
    commit: { sha: "c1", subject: "test: loosen" },
} as const;

const report = (over: Partial<PushReportEntry> & Pick<PushReportEntry, "id" | "at">): PushReportEntry => ({
    version: 1,
    kind: "push",
    remote: "origin",
    pushes: [{ ref: "refs/heads/main", head: `head-${over.id}`, base: `base-${over.id}`, commits: 2 }],
    findings: [],
    recheck: ["node", "_tools/scripts/verify/push-report.mjs", "--recheck"],
    ...over,
});

const statesOf = (state: PushChecksState): Record<string, string[]> =>
    Object.fromEntries(state.pushes.map((push) => [push.id, push.findings.map((finding) => `${finding.id}=${finding.state}`)]));

describe("reading the report the hook leaves", () => {
    test("keeps every entry, push and finding that parses, oldest first, and drops the rest", () => {
        const text = JSON.stringify([
            { version: 1, id: "b", at: 20, kind: "recheck", measured: { checks: {}, lint: "passed" }, recheck: ["node", "x.mjs"] },
            { version: 2, id: "future", at: 30, kind: "push", recheck: [] },
            { version: 1, id: "", at: 25, kind: "push", recheck: [] },
            {
                version: 1,
                id: "a",
                at: 10,
                kind: "push",
                pushes: [{ ref: "refs/heads/main", head: "h", commits: 1 }, { ref: "refs/heads/x" }],
                findings: [CATCH, { kind: "typecheck", text: "t", key: "" }],
                measured: { checks: "none" },
                recheck: "node x.mjs",
            },
        ]);

        expect(parsePushReport(text)).toEqual([
            {
                version: 1,
                id: "a",
                at: 10,
                kind: "push",
                pushes: [{ ref: "refs/heads/main", head: "h", commits: 1 }],
                findings: [CATCH],
                measured: undefined,
                recheck: [],
            },
            { version: 1, id: "b", at: 20, kind: "recheck", measured: { checks: {}, lint: "passed" }, recheck: ["node", "x.mjs"] },
        ]);
    });

    test("reads a file that is not a JSON array as holding nothing", () => {
        expect(parsePushReport("[{")).toEqual([]);
        expect(parsePushReport(`{"version":1}`)).toEqual([]);
    });
});

describe("a finding's id", () => {
    test("is what measured it, the check, and a digest of its key, or of its text when it has no key", () => {
        expect(pushFindingId(CATCH)).toBe("check:silent-catch:07j3zlp");
        expect(pushFindingId({ kind: "ratchet", key: "", text: "src/a.ts" })).toBe("ratchet::0hhtd00");
        expect(pushFindingId({ kind: "ratchet", key: "src/a.ts", text: "something else" })).toBe("ratchet::0hhtd00");
    });
});

describe("filing a push", () => {
    test("files its findings open, under the branch it moved, the range of its first push and every commit it carried", () => {
        const { state, resolved } = ingestPush(
            EMPTY,
            "app",
            report({
                id: "r1",
                at: 10,
                pushes: [
                    { ref: "refs/heads/main", head: "h1", base: "b1", commits: 2 },
                    { ref: "refs/heads/next", head: "h2", commits: 3 },
                ],
                findings: [CATCH, LINT, RATCHET, CATCH],
            }),
        );

        expect(resolved).toBe(0);
        expect(state).toEqual({
            pushes: [
                {
                    project: "app",
                    id: "r1",
                    at: 10,
                    remote: "origin",
                    branch: "main",
                    base: "b1",
                    head: "h1",
                    commits: 5,
                    findings: [
                        {
                            id: "check:silent-catch:07j3zlp",
                            kind: "check",
                            check: "silent-catch",
                            source: "silent-catch",
                            recheckable: true,
                            gate: "code",
                            text: CATCH.text,
                            command: CATCH.command,
                            state: "open",
                            key: CATCH.key,
                        },
                        {
                            id: pushFindingId(LINT),
                            kind: "lint",
                            source: "lint",
                            recheckable: true,
                            text: LINT.text,
                            command: LINT.command,
                            state: "open",
                            key: "",
                        },
                        {
                            id: "ratchet::0uhne5n",
                            kind: "ratchet",
                            source: "ratchet",
                            recheckable: false,
                            text: RATCHET.text,
                            commit: RATCHET.commit,
                            state: "open",
                            key: RATCHET.key,
                        },
                    ],
                },
            ],
            seen: ["r1"],
        });
    });

    test("leaves out what is still open from an earlier push of the same project, and nothing another project holds", () => {
        const first = ingestPush(EMPTY, "app", report({ id: "r1", at: 10, findings: [CATCH] })).state;
        const other = ingestPush(first, "lib", report({ id: "r2", at: 20, findings: [CATCH] })).state;
        const again = ingestPush(other, "app", report({ id: "r3", at: 30, findings: [CATCH, LINT] })).state;

        expect(statesOf(again)).toEqual({
            r3: [`${pushFindingId(LINT)}=open`],
            r2: ["check:silent-catch:07j3zlp=open"],
            r1: ["check:silent-catch:07j3zlp=open"],
        });
    });

    test("files the same problem again once the earlier one was dismissed", () => {
        const first = ingestPush(EMPTY, "app", report({ id: "r1", at: 10, findings: [CATCH] })).state;
        const dismissed = dismissIn(first, "app", undefined, false, 15).state;

        expect(statesOf(ingestPush(dismissed, "app", report({ id: "r2", at: 20, findings: [CATCH] })).state)).toEqual({
            r2: ["check:silent-catch:07j3zlp=open"],
            r1: ["check:silent-catch:07j3zlp=dismissed"],
        });
    });

    test("files a report it already filed only once", () => {
        const first = ingestPush(EMPTY, "app", report({ id: "r1", at: 10, findings: [CATCH] })).state;

        expect(ingestPush(first, "app", report({ id: "r1", at: 10, findings: [CATCH] })).state.pushes).toEqual(first.pushes);
    });

    test("sorts a push filed late into its place by when it was checked", () => {
        const late = ingestPush(ingestPush(EMPTY, "app", report({ id: "r2", at: 20 })).state, "app", report({ id: "r1", at: 10 })).state;

        expect(late.pushes.map((push) => push.id)).toEqual(["r2", "r1"]);
        expect(late.seen).toEqual(["r1", "r2"]);
    });
});

describe("measuring again", () => {
    // Three open findings of each measurable kind, on a push checked at 10.
    const standing = (): PushChecksState =>
        ingestPush(
            EMPTY,
            "app",
            report({
                id: "r1",
                at: 10,
                findings: [
                    CATCH,
                    { ...CATCH, text: "src/c.ts:2 empty catch block", key: "src/c.ts:2 silent catch" },
                    LINT,
                    RATCHET,
                    { kind: "check", check: "paths", text: "p", key: "p" },
                ],
            }),
        ).state;

    test("resolves a check's finding its keys no longer name, keeps one they do, and resolves the linter's on a pass", () => {
        const { state, resolved } = applyMeasured(
            standing(),
            "app",
            { checks: { "silent-catch": { ok: false, measured: true, keys: ["src/c.ts:2 silent catch"] } }, lint: "passed" },
            50,
        );

        expect(resolved).toBe(2);
        expect(state.pushes[0]).toMatchObject({ measuredAt: 50 });
        expect(state.pushes[0]?.findings.map(({ kind, text, state: now, settledAt }) => ({ kind, text, now, settledAt }))).toEqual([
            { kind: "check", text: CATCH.text, now: "resolved", settledAt: 50 },
            { kind: "check", text: "src/c.ts:2 empty catch block", now: "open", settledAt: undefined },
            { kind: "lint", text: LINT.text, now: "resolved", settledAt: 50 },
            { kind: "ratchet", text: RATCHET.text, now: "open", settledAt: undefined },
            { kind: "check", text: "p", now: "open", settledAt: undefined },
        ]);
    });

    test("resolves every finding of a check that passed, and leaves one it could not measure", () => {
        const { state, resolved } = applyMeasured(
            standing(),
            "app",
            { checks: { "silent-catch": { ok: true, measured: true, keys: [] }, paths: { ok: true, measured: false, keys: [] } }, lint: "failed" },
            50,
        );

        expect(resolved).toBe(2);
        expect(statesOf(state)["r1"]?.map((entry) => entry.split("=")[1])).toEqual(["resolved", "resolved", "open", "open", "open"]);
    });

    test("says nothing of a push checked after it, or of another project", () => {
        const both = ingestPush(standing(), "lib", report({ id: "r2", at: 10, findings: [CATCH] })).state;
        const measured = { checks: { "silent-catch": { ok: true, measured: true, keys: [] } } };

        expect(applyMeasured(both, "app", measured, 5)).toEqual({ state: both, resolved: 0 });
        expect(statesOf(applyMeasured(both, "app", measured, 50).state)["r2"]).toEqual(["check:silent-catch:07j3zlp=open"]);
    });

    test("a push's own measurement resolves what older pushes left, never what it brought", () => {
        const next = ingestPush(
            standing(),
            "app",
            report({
                id: "r2",
                at: 20,
                findings: [LINT, { kind: "lint", text: "src/d.ts:1 eqeqeq", key: "" }],
                measured: { checks: { "silent-catch": { ok: true, measured: true, keys: [] } }, lint: "passed" },
            }),
        );

        expect(next.resolved).toBe(3);
        expect(statesOf(next.state)["r2"]).toEqual([`${pushFindingId({ kind: "lint", text: "src/d.ts:1 eqeqeq", key: "" })}=open`]);
        expect(next.state.pushes[1]).toMatchObject({ id: "r1", measuredAt: 20 });
    });

    test("a recheck or a refused push files nothing but its measurement, and is seen", () => {
        const { state, resolved } = ingestMeasurement(
            standing(),
            "app",
            report({ id: "k1", at: 40, kind: "recheck", pushes: undefined, measured: { checks: {}, lint: "passed" } }),
        );

        expect(resolved).toBe(1);
        expect(state.pushes.map((push) => push.id)).toEqual(["r1"]);
        expect(state.seen).toEqual(["k1", "r1"]);
    });
});

describe("dismissing", () => {
    const two = (): PushChecksState => ingestPush(EMPTY, "app", report({ id: "r1", at: 10, findings: [CATCH, LINT] })).state;

    test("sets every open finding in the project aside when none is named, the named ones otherwise", () => {
        expect(dismissIn(two(), "app", undefined, false, 20).changed).toBe(2);
        expect(dismissIn(two(), "lib", undefined, false, 20)).toEqual({ state: two(), changed: 0 });

        const named = dismissIn(two(), "app", [pushFindingId(LINT)], false, 20);
        expect(named.changed).toBe(1);
        expect(named.state.pushes[0]?.findings[1]).toMatchObject({ state: "dismissed", settledAt: 20 });
        expect(named.state.pushes[0]?.findings[0]).toMatchObject({ state: "open" });
    });

    test("opens a named dismissed finding again, unless the same problem is already open in a later push", () => {
        const dismissed = dismissIn(two(), "app", undefined, false, 20).state;
        const restored = dismissIn(dismissed, "app", [pushFindingId(LINT)], true, 30);

        expect(restored.changed).toBe(1);
        expect(restored.state.pushes[0]?.findings[1]).toEqual({
            id: pushFindingId(LINT),
            kind: "lint",
            source: "lint",
            recheckable: true,
            text: LINT.text,
            command: LINT.command,
            state: "open",
            key: "",
        });
        expect(dismissIn(dismissed, "app", undefined, true, 30).changed).toBe(0);

        const refiled = ingestPush(dismissed, "app", report({ id: "r2", at: 40, findings: [CATCH] })).state;
        expect(dismissIn(refiled, "app", [pushFindingId(CATCH)], true, 50).changed).toBe(0);
    });

    // "Dismiss all" names every open id; its undo names the same ids and must bring back exactly what it set aside, not
    // a copy somebody dismissed a week before.
    test("sets a named finding aside in every push holding it open, and an undo reopens the copy dismissed last", () => {
        const earlier = dismissIn(ingestPush(EMPTY, "app", report({ id: "r1", at: 10, findings: [CATCH] })).state, "app", undefined, false, 15).state;
        const both = ingestPush(earlier, "app", report({ id: "r2", at: 20, findings: [CATCH, LINT] })).state;
        const all = dismissIn(both, "app", [pushFindingId(CATCH), pushFindingId(LINT)], false, 30);

        expect(all.changed).toBe(2);
        expect(statesOf(all.state)).toEqual({
            r2: ["check:silent-catch:07j3zlp=dismissed", `${pushFindingId(LINT)}=dismissed`],
            r1: ["check:silent-catch:07j3zlp=dismissed"],
        });

        const undone = dismissIn(all.state, "app", [pushFindingId(CATCH), pushFindingId(LINT)], true, 40);
        expect(undone.changed).toBe(2);
        expect(statesOf(undone.state)).toEqual({
            r2: ["check:silent-catch:07j3zlp=open", `${pushFindingId(LINT)}=open`],
            r1: ["check:silent-catch:07j3zlp=dismissed"],
        });
    });
});

describe("what is kept", () => {
    const push = (index: number, openFinding: boolean): StoredPush => ({
        project: "app",
        id: `r${index}`,
        at: 1_000 - index,
        head: `h${index}`,
        commits: 1,
        findings: [{ id: `f${index}`, kind: "lint", text: "t", state: openFinding ? "open" : "resolved", key: "" }],
    });

    test("is the newest pushes, and any older one still holding an open finding up to the cap", () => {
        const settled = Array.from({ length: PUSHES_KEPT + 5 }, (_, index) => push(index, false));
        expect(retained(settled).map((each) => each.id)).toEqual(settled.slice(0, PUSHES_KEPT).map((each) => each.id));

        const holding = Array.from({ length: PUSHES_KEPT + 5 }, (_, index) => push(index, index === PUSHES_KEPT + 2));
        expect(retained(holding).map((each) => each.id)).toEqual([...holding.slice(0, PUSHES_KEPT).map((each) => each.id), `r${PUSHES_KEPT + 2}`]);

        const allOpen = Array.from({ length: PUSHES_CAP + 5 }, (_, index) => push(index, true));
        expect(retained(allOpen)).toHaveLength(PUSHES_CAP);
    });

    test("remembers the newest report ids, up to its bound", () => {
        let state = EMPTY;
        for (let index = 0; index < SEEN_KEPT + 3; index += 1) {
            state = ingestMeasurement(state, "app", report({ id: `k${index}`, at: index, kind: "recheck" })).state;
        }
        expect(state.seen).toHaveLength(SEEN_KEPT);
        expect(state.seen[0]).toBe(`k${SEEN_KEPT + 2}`);
        expect(state.seen.at(-1)).toBe("k3");
    });
});

// Any repository's tooling may report: a finding names what measured it by a free `source`, and says whether a later
// measurement can clear it. The kind an older editor reads is derived from it, and so is the id, so a finding keeps its
// id whichever way its report named it.
describe("a finding named by its source", () => {
    const MYPY = { source: "mypy", recheckable: true, text: "svc/a.py:3 error", key: "svc/a.py:# error", command: "make typecheck" } as const;

    test("is filed with its source, as a check of that name for an editor that reads only the kind", () => {
        const { state } = ingestPush(EMPTY, "svc", report({ id: "g1", at: 10, findings: [MYPY] }));

        expect(state.pushes[0]?.findings).toEqual([
            {
                id: pushFindingId({ kind: "check", check: "mypy", key: MYPY.key, text: MYPY.text }),
                kind: "check",
                check: "mypy",
                source: "mypy",
                recheckable: true,
                text: MYPY.text,
                command: MYPY.command,
                state: "open",
                key: MYPY.key,
            },
        ]);
    });

    test("keeps the id an older report gave the same problem under its kind", () => {
        const older = ingestPush(EMPTY, "app", report({ id: "r1", at: 10, findings: [CATCH] })).state;
        const newer = ingestPush(EMPTY, "app", report({ id: "r1", at: 10, findings: [{ ...CATCH, kind: undefined, check: undefined, source: "silent-catch" }] })).state;

        expect(newer.pushes[0]?.findings[0]?.id).toBe(older.pushes[0]?.findings[0]?.id);
    });

    test("is cleared by a measurement of its source, and one its report says no measurement can clear waits to be dismissed", () => {
        const signoff = { source: "signoff", recheckable: false, text: "commit c1 is not signed off", key: "c1" } as const;
        const filed = ingestPush(EMPTY, "svc", report({ id: "g1", at: 10, findings: [MYPY, signoff] })).state;

        const { state, resolved } = applyMeasured(filed, "svc", { checks: { mypy: { ok: true, measured: true, keys: [] }, signoff: { ok: true, measured: true, keys: [] } } }, 20);

        expect(resolved).toBe(1);
        expect(statesOf(state)).toEqual({ g1: [`${pushFindingId({ kind: "check", check: "mypy", key: MYPY.key, text: MYPY.text })}=resolved`, `${pushFindingId({ kind: "check", check: "signoff", key: "c1", text: signoff.text })}=open`] });
    });
});

// A push the repository's own hook refused reached no remote and left no report of this sandbox's tooling: the daemon
// files it itself, so its fix is the same hand-over as every other finding's.
describe("a refused push", () => {
    const refusal = (at: number, output = "typecheck failed") => ({ at, head: `head-${at}`, branch: "main", remote: "origin", output });

    test("is filed as a push that reached nothing, with the hook's words as its one finding, which no measurement clears", () => {
        const state = fileRefusal(EMPTY, "app", refusal(10));

        expect(state.pushes).toEqual([
            {
                project: "app",
                id: "refused-a",
                at: 10,
                remote: "origin",
                branch: "main",
                head: "head-10",
                commits: 0,
                refused: true,
                findings: [
                    {
                        id: pushFindingId({ kind: "check", check: REFUSAL_SOURCE, key: "", text: "typecheck failed" }),
                        kind: "check",
                        check: REFUSAL_SOURCE,
                        source: REFUSAL_SOURCE,
                        recheckable: false,
                        text: "typecheck failed",
                        command: "git push --dry-run",
                        state: "open",
                        key: "",
                    },
                ],
            },
        ]);
        expect(applyMeasured(state, "app", { checks: { [REFUSAL_SOURCE]: { ok: true, measured: true, keys: [] } } }, 20).resolved).toBe(0);
    });

    test("is answered by the next push, refused again or gone, and only in its own project", () => {
        const two = fileRefusal(fileRefusal(fileRefusal(EMPTY, "app", refusal(10)), "lib", refusal(12)), "app", refusal(20, "lint failed"));

        expect(two.pushes.map(({ id, project, findings }) => [project, id, findings.map(({ state }) => state)])).toEqual([
            ["app", "refused-k", ["open"]],
            ["lib", "refused-c", ["open"]],
            ["app", "refused-a", ["resolved"]],
        ]);
        const gone = settleRefusals(two, "app", 30);
        expect(gone.pushes.map(({ id, findings }) => [id, findings.map(({ state, settledAt }) => `${state}@${settledAt ?? "-"}`)])).toEqual([
            ["refused-k", ["resolved@30"]],
            ["refused-c", ["open@-"]],
            ["refused-a", ["resolved@20"]],
        ]);
        expect(settleRefusals(gone, "app", 40)).toBe(gone);
    });
});
