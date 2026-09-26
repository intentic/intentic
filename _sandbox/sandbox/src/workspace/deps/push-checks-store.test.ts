import { fnvDigest, type MainlineRouting } from "@intentic/sandbox-contract";
import { convertDocument } from "../../store/evolution/conversions.js";
import {
    applyMeasured,
    decidedIn,
    dismissIn,
    fileRefusal,
    ingestMeasurement,
    ingestPush,
    owedIn,
    parsePushReport,
    publicPushReds,
    pushChecksDocument,
    type PushChecksState,
    pushFindingId,
    PUSHES_CAP,
    PUSHES_KEPT,
    type PushReportEntry,
    REFUSAL_SOURCE,
    retained,
    SEEN_KEPT,
    settleRefusals,
    type StoredPush,
} from "./push-checks-store.js";

// What the pre-push hook let through, as the store files it: each push keeps what it found, and the project's push Red
// owes it until a later measurement no longer prints it or somebody dismisses it. The file around it (jsonFile) and the
// report's discovery are push-checks.integration.test.ts's.

const EMPTY: PushChecksState = { pushes: [], reds: {}, ended: {}, seen: [] };

const CATCH = {
    source: "silent-catch",
    recheckable: true,
    gate: "code",
    text: "src/a.ts:1 empty catch block",
    key: "src/a.ts:1 silent catch",
    command: "node _tools/checks/run.mjs --only silent-catch",
} as const;
const LINT = { source: "lint", recheckable: true, text: "src/b.ts:4 no-unused-vars", key: "", command: "node _tools/oxlint/lint-edit.mjs src/b.ts" } as const;
const RATCHET = {
    source: "ratchet",
    recheckable: false,
    text: "tests/a.test.ts: toEqual became toMatchObject",
    key: "tests/a.test.ts",
    commit: { sha: "c1", subject: "test: loosen" },
} as const;
const CATCH_ID = pushFindingId(CATCH);
const LINT_ID = pushFindingId(LINT);

const report = (over: Partial<PushReportEntry> & Pick<PushReportEntry, "id" | "at">): PushReportEntry => ({
    version: 1,
    kind: "push",
    remote: "origin",
    pushes: [{ ref: "refs/heads/main", head: `head-${over.id}`, base: `base-${over.id}`, commits: 2 }],
    findings: [],
    recheck: ["node", "_tools/scripts/verify/push-report.mjs", "--recheck"],
    ...over,
});

// What each push found, and what the project owes, by id.
const foundOf = (state: PushChecksState): Record<string, string[]> =>
    Object.fromEntries(state.pushes.map((push) => [push.id, push.findings.map((finding) => finding.id)]));
const owedOf = (state: PushChecksState, project: string): string[] => owedIn(state, project).map((finding) => finding.id);

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
                findings: [CATCH, { text: "t", key: "" }],
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
    test("is what measured it and a digest of its key, or of its text when it has no key", () => {
        expect(CATCH_ID).toBe(`silent-catch:${fnvDigest(CATCH.key)}`);
        expect(pushFindingId({ source: "ratchet", key: "", text: "src/a.ts" })).toBe(`ratchet:${fnvDigest("src/a.ts")}`);
        expect(pushFindingId({ source: "ratchet", key: "src/a.ts", text: "something else" })).toBe(`ratchet:${fnvDigest("src/a.ts")}`);
    });
});

describe("filing a push", () => {
    test("files what it found under the branch it moved, the range of its first push and every commit it carried, and begins the project's red", () => {
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

        const findings = [
            { id: CATCH_ID, source: "silent-catch", recheckable: true, gate: "code" as const, text: CATCH.text, command: CATCH.command, key: CATCH.key },
            { id: LINT_ID, source: "lint", recheckable: true, text: LINT.text, command: LINT.command, key: "" },
            { id: pushFindingId(RATCHET), source: "ratchet", recheckable: false, text: RATCHET.text, commit: RATCHET.commit, key: RATCHET.key },
        ];
        expect(resolved).toBe(0);
        expect(state).toEqual({
            pushes: [{ project: "app", id: "r1", at: 10, remote: "origin", branch: "main", base: "b1", head: "h1", commits: 5, findings }],
            reds: { app: { since: 10, findings, suspects: [], named: false, decisions: [] } },
            ended: {},
            seen: ["r1"],
        });
    });

    // A hook written before `source` named what measured a finding only by its kind (and check): read once, at the file.
    test("reads a finding a hook named only by its kind as the source that kind names", () => {
        const { state } = ingestPush(
            EMPTY,
            "app",
            report({
                id: "r1",
                at: 10,
                findings: [
                    { kind: "check", check: "silent-catch", gate: "code", text: CATCH.text, key: CATCH.key, command: CATCH.command },
                    { kind: "ratchet", text: RATCHET.text, key: RATCHET.key },
                ],
            }),
        );

        expect(owedIn(state, "app").map(({ id, source, recheckable }) => ({ id, source, recheckable }))).toEqual([
            { id: CATCH_ID, source: "silent-catch", recheckable: true },
            { id: pushFindingId(RATCHET), source: "ratchet", recheckable: false },
        ]);
    });

    test("leaves out what the project still owes from an earlier push, and nothing another project owes", () => {
        const first = ingestPush(EMPTY, "app", report({ id: "r1", at: 10, findings: [CATCH] })).state;
        const other = ingestPush(first, "lib", report({ id: "r2", at: 20, findings: [CATCH] })).state;
        const again = ingestPush(other, "app", report({ id: "r3", at: 30, findings: [CATCH, LINT] })).state;

        expect(foundOf(again)).toEqual({ r3: [LINT_ID], r2: [CATCH_ID], r1: [CATCH_ID] });
        expect(owedOf(again, "app")).toEqual([CATCH_ID, LINT_ID]);
        // Still the one red, begun by the first push.
        expect(again.reds["app"]?.since).toBe(10);
        expect(again.reds["lib"]?.since).toBe(20);
    });

    test("files the same problem again once the earlier one was dismissed, as a fresh red", () => {
        const first = ingestPush(EMPTY, "app", report({ id: "r1", at: 10, findings: [CATCH] })).state;
        const dismissed = dismissIn(first, "app", undefined, false, 15).state;
        const again = ingestPush(dismissed, "app", report({ id: "r2", at: 20, findings: [CATCH] })).state;

        expect(foundOf(again)).toEqual({ r2: [CATCH_ID], r1: [CATCH_ID] });
        expect(again.reds["app"]).toEqual({ since: 20, findings: [{ ...CATCH, id: CATCH_ID }], suspects: [], named: false, decisions: [] });
        expect(again.ended).toEqual({});
    });

    test("files a report it already filed only once", () => {
        const first = ingestPush(EMPTY, "app", report({ id: "r1", at: 10, findings: [CATCH] })).state;
        const twice = ingestPush(first, "app", report({ id: "r1", at: 10, findings: [CATCH] })).state;

        expect(twice.pushes).toEqual(first.pushes);
        expect(twice.reds).toEqual(first.reds);
    });

    test("sorts a push filed late into its place by when it was checked", () => {
        const late = ingestPush(ingestPush(EMPTY, "app", report({ id: "r2", at: 20 })).state, "app", report({ id: "r1", at: 10 })).state;

        expect(late.pushes.map((push) => push.id)).toEqual(["r2", "r1"]);
        expect(late.seen).toEqual(["r1", "r2"]);
        expect(late.reds).toEqual({});
    });
});

describe("measuring again", () => {
    const OTHER_CATCH = { ...CATCH, text: "src/c.ts:2 empty catch block", key: "src/c.ts:2 silent catch" };
    const PATHS = { source: "paths", recheckable: true, text: "p", key: "p" } as const;
    // Five owed findings, on a push checked at 10.
    const standing = (): PushChecksState =>
        ingestPush(EMPTY, "app", report({ id: "r1", at: 10, findings: [CATCH, OTHER_CATCH, LINT, RATCHET, PATHS] })).state;

    test("resolves a check's finding its keys no longer name, keeps one they do, and resolves the linter's on a pass", () => {
        const { state, resolved } = applyMeasured(
            standing(),
            "app",
            { checks: { "silent-catch": { ok: false, measured: true, keys: [OTHER_CATCH.key] } }, lint: "passed" },
            50,
        );

        expect(resolved).toBe(2);
        expect(owedOf(state, "app")).toEqual([pushFindingId(OTHER_CATCH), pushFindingId(RATCHET), pushFindingId(PATHS)]);
        expect(state.reds["app"]?.decisions).toEqual([
            { kind: "resolved", at: 50, findings: [CATCH_ID, LINT_ID], detail: "A later measurement no longer printed them." },
        ]);
        // What the push found is its record, whatever became of it since.
        expect(foundOf(state)).toEqual(foundOf(standing()));
    });

    test("resolves every finding of a check that passed, and leaves one it could not measure", () => {
        const { state, resolved } = applyMeasured(
            standing(),
            "app",
            { checks: { "silent-catch": { ok: true, measured: true, keys: [] }, paths: { ok: true, measured: false, keys: [] } }, lint: "failed" },
            50,
        );

        expect(resolved).toBe(2);
        expect(owedOf(state, "app")).toEqual([LINT_ID, pushFindingId(RATCHET), pushFindingId(PATHS)]);
    });

    test("ends the red when nothing is owed after it, keeping what it ended with", () => {
        const one = ingestPush(EMPTY, "app", report({ id: "r1", at: 10, findings: [CATCH] })).state;
        const { state } = applyMeasured(one, "app", { checks: { "silent-catch": { ok: true, measured: true, keys: [] } } }, 50);

        expect(state.reds).toEqual({});
        expect(state.ended).toEqual({
            app: {
                since: 10,
                findings: [],
                suspects: [],
                named: false,
                decisions: [{ kind: "resolved", at: 50, findings: [CATCH_ID], detail: "A later measurement no longer printed them." }],
            },
        });
    });

    test("says nothing of a push checked after it, or of another project", () => {
        const both = ingestPush(standing(), "lib", report({ id: "r2", at: 10, findings: [CATCH] })).state;
        const measured = { checks: { "silent-catch": { ok: true, measured: true, keys: [] } } };

        expect(applyMeasured(both, "app", measured, 5)).toEqual({ state: both, resolved: 0 });
        expect(owedOf(applyMeasured(both, "app", measured, 50).state, "lib")).toEqual([CATCH_ID]);
    });

    test("a push's own measurement resolves what earlier pushes left, never what it brought", () => {
        const EQ = { source: "lint", recheckable: true, text: "src/d.ts:1 eqeqeq", key: "" } as const;
        const next = ingestPush(
            standing(),
            "app",
            report({
                id: "r2",
                at: 20,
                findings: [LINT, EQ],
                measured: { checks: { "silent-catch": { ok: true, measured: true, keys: [] } }, lint: "passed" },
            }),
        );

        expect(next.resolved).toBe(3);
        expect(foundOf(next.state)["r2"]).toEqual([LINT_ID, pushFindingId(EQ)]);
        expect(owedOf(next.state, "app")).toEqual([pushFindingId(RATCHET), pushFindingId(PATHS), LINT_ID, pushFindingId(EQ)]);
        expect(next.state.reds["app"]?.since).toBe(10);
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

    test("clears a finding its report says a measurement can, by its source, and leaves one it says none can to be dismissed", () => {
        const MYPY = { source: "mypy", recheckable: true, text: "svc/a.py:3 error", key: "svc/a.py:# error", command: "make typecheck" } as const;
        const SIGNOFF = { source: "signoff", recheckable: false, text: "commit c1 is not signed off", key: "c1" } as const;
        const filed = ingestPush(EMPTY, "svc", report({ id: "g1", at: 10, findings: [MYPY, SIGNOFF] })).state;

        const { state, resolved } = applyMeasured(
            filed,
            "svc",
            { checks: { mypy: { ok: true, measured: true, keys: [] }, signoff: { ok: true, measured: true, keys: [] } } },
            20,
        );

        expect(resolved).toBe(1);
        expect(owedOf(state, "svc")).toEqual([pushFindingId(SIGNOFF)]);
    });
});

describe("dismissing", () => {
    const two = (): PushChecksState => ingestPush(EMPTY, "app", report({ id: "r1", at: 10, findings: [CATCH, LINT] })).state;

    test("sets every owed finding in the project aside when none is named, the named ones otherwise, as a decision on its red", () => {
        const all = dismissIn(two(), "app", undefined, false, 20);
        expect(all.changed).toBe(2);
        expect(all.state.reds).toEqual({});
        expect(all.state.ended["app"]?.decisions).toEqual([{ kind: "dismissed", at: 20, findings: [CATCH_ID, LINT_ID] }]);
        expect(dismissIn(two(), "lib", undefined, false, 20)).toEqual({ state: two(), changed: 0 });

        const named = dismissIn(two(), "app", [LINT_ID], false, 20);
        expect(named.changed).toBe(1);
        expect(named.state.reds["app"]).toMatchObject({ since: 10, decisions: [{ kind: "dismissed", at: 20, findings: [LINT_ID] }] });
        expect(owedOf(named.state, "app")).toEqual([CATCH_ID]);
    });

    test("opens a named dismissed finding again, unless the same problem is owed again already", () => {
        const one = dismissIn(two(), "app", [LINT_ID], false, 20).state;
        const restored = dismissIn(one, "app", [LINT_ID], true, 30);

        expect(restored.changed).toBe(1);
        expect(restored.state.reds["app"]).toEqual({
            since: 10,
            findings: [
                { ...CATCH, id: CATCH_ID },
                { ...LINT, id: LINT_ID },
            ],
            suspects: [],
            named: false,
            decisions: [],
        });
        expect(dismissIn(one, "app", undefined, true, 30).changed).toBe(0);
        // Only what a dismissal names: an owed finding, or one never dismissed, is not "opened again".
        expect(dismissIn(one, "app", [CATCH_ID], true, 30).changed).toBe(0);

        const all = dismissIn(two(), "app", undefined, false, 20).state;
        const refiled = ingestPush(all, "app", report({ id: "r2", at: 40, findings: [CATCH] })).state;
        expect(dismissIn(refiled, "app", [CATCH_ID], true, 50).changed).toBe(0);
    });

    // "Dismiss all" names every owed id and ends the red; its undo names the same ids and must bring back exactly that
    // red, begun when it was, with the hand-over it had, not a fresh one.
    test("an undo of the dismissal that ended the red brings the same red back", () => {
        const handed: MainlineRouting = { kind: "fix-up", conversationId: "push-fix-app-1", at: 12 };
        const red = decidedIn(two(), "app", handed);
        const all = dismissIn(red, "app", [CATCH_ID, LINT_ID], false, 30);

        expect(all.changed).toBe(2);
        expect(all.state.reds).toEqual({});

        const undone = dismissIn(all.state, "app", [CATCH_ID, LINT_ID], true, 40);
        expect(undone.changed).toBe(2);
        expect(undone.state.reds["app"]).toEqual({ ...red.reds["app"]!, decisions: [handed] });
        expect(undone.state.ended).toEqual({});
    });
});

describe("what is kept", () => {
    const push = (index: number): StoredPush => ({
        project: "app",
        id: `r${index}`,
        at: 1_000 - index,
        head: `h${index}`,
        commits: 1,
        findings: [{ id: `f${index}`, source: "lint", recheckable: true, text: "t", key: "" }],
    });
    const owing = (pushes: readonly StoredPush[], ids: readonly string[]): PushChecksState => ({
        ...EMPTY,
        pushes: [...pushes],
        reds: {
            app: {
                since: 1,
                findings: pushes.flatMap((each) => each.findings).filter((finding) => ids.includes(finding.id)),
                suspects: [],
                named: false,
                decisions: [],
            },
        },
    });

    test("is the newest pushes, and any older one that brought in something still owed, up to the cap", () => {
        const pushes = Array.from({ length: PUSHES_KEPT + 5 }, (_, index) => push(index));
        expect(retained(owing(pushes, [])).pushes.map((each) => each.id)).toEqual(pushes.slice(0, PUSHES_KEPT).map((each) => each.id));
        expect(retained(owing(pushes, [`f${PUSHES_KEPT + 2}`])).pushes.map((each) => each.id)).toEqual([
            ...pushes.slice(0, PUSHES_KEPT).map((each) => each.id),
            `r${PUSHES_KEPT + 2}`,
        ]);

        const many = Array.from({ length: PUSHES_CAP + 5 }, (_, index) => push(index));
        expect(retained(owing(many, many.map((each) => `f${each.id.slice(1)}`))).pushes).toHaveLength(PUSHES_CAP);
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

// A push the repository's own hook refused reached no remote and left no report of this sandbox's tooling: the daemon
// files it itself, so its fix is the same hand-over as every other finding's.
describe("a refused push", () => {
    const refusal = (at: number, output = "typecheck failed") => ({ at, head: `head-${at}`, branch: "main", remote: "origin", output });
    const refusalId = (text: string): string => pushFindingId({ source: REFUSAL_SOURCE, key: "", text });

    test("is filed as a push that reached nothing, the hook's words its one finding, owed until a push answers it", () => {
        const state = fileRefusal(EMPTY, "app", refusal(10));
        const finding = {
            id: refusalId("typecheck failed"),
            source: REFUSAL_SOURCE,
            recheckable: false,
            text: "typecheck failed",
            command: "git push --dry-run",
            key: "",
        };

        expect(state.pushes).toEqual([
            { project: "app", id: "refused-a", at: 10, remote: "origin", branch: "main", head: "head-10", commits: 0, refused: true, findings: [finding] },
        ]);
        expect(state.reds["app"]).toEqual({ since: 10, findings: [finding], suspects: [], named: false, decisions: [] });
        expect(applyMeasured(state, "app", { checks: { [REFUSAL_SOURCE]: { ok: true, measured: true, keys: [] } } }, 20).resolved).toBe(0);
    });

    test("is answered by the next push, refused again or gone, and only in its own project", () => {
        const two = fileRefusal(fileRefusal(fileRefusal(EMPTY, "app", refusal(10)), "lib", refusal(12)), "app", refusal(20, "lint failed"));

        expect(owedOf(two, "app")).toEqual([refusalId("lint failed")]);
        expect(owedOf(two, "lib")).toEqual([refusalId("typecheck failed")]);
        // Answered, it ended the red it was owed by: the refusal after it begins its own, as a fresh hand-over.
        expect(two.reds["app"]).toMatchObject({ since: 20, decisions: [] });
        // The same words refused again are still owed, by the newer push.
        expect(owedOf(fileRefusal(two, "app", refusal(25, "lint failed")), "app")).toEqual([refusalId("lint failed")]);

        const gone = settleRefusals(two, "app", 30);
        expect(gone.reds["app"]).toBeUndefined();
        expect(owedOf(gone, "lib")).toEqual([refusalId("typecheck failed")]);
        expect(settleRefusals(gone, "app", 40)).toBe(gone);
    });
});

describe("the wire", () => {
    test("carries each project's push red as a Red of source push scoped to the project, without the keys", () => {
        const state = ingestPush(EMPTY, "", report({ id: "r1", at: 10, findings: [CATCH] })).state;
        const { key: _key, ...finding } = { ...CATCH, id: CATCH_ID };

        expect(publicPushReds(state.reds)).toEqual([{ source: "push", scope: "", since: 10, findings: [finding], suspects: [], named: false, decisions: [] }]);
    });
});

// The file as releases through 2026-09-25 wrote it: a state on every finding, what measured it by kind and check, ids
// spelled from the kind.
describe("the file before push reds", () => {
    test("converts to what each push found, and each project's open findings owed by its red from the oldest push holding one", () => {
        const legacy = {
            pushes: [
                {
                    project: "app",
                    id: "r2",
                    at: 20,
                    head: "h2",
                    commits: 1,
                    measuredAt: 30,
                    findings: [
                        { id: "lint::x", kind: "lint", text: LINT.text, key: "", command: LINT.command, state: "open" },
                        { id: "ratchet::y", kind: "ratchet", text: RATCHET.text, key: RATCHET.key, state: "dismissed", settledAt: 25 },
                    ],
                },
                {
                    project: "app",
                    id: "r1",
                    at: 10,
                    head: "h1",
                    commits: 2,
                    findings: [
                        {
                            id: "check:silent-catch:z",
                            kind: "check",
                            check: "silent-catch",
                            source: "silent-catch",
                            recheckable: true,
                            gate: "code",
                            text: CATCH.text,
                            key: CATCH.key,
                            command: CATCH.command,
                            state: "open",
                        },
                    ],
                },
                { project: "lib", id: "r0", at: 5, head: "h0", commits: 1, findings: [{ id: "lint::w", kind: "lint", text: "old", key: "", state: "resolved", settledAt: 6 }] },
            ],
            seen: ["r2", "r1", "r0"],
        };

        const { value } = convertDocument(pushChecksDocument.history, "object", legacy);
        const state = pushChecksDocument.schema.parse(value);

        const catchFound = { id: CATCH_ID, source: "silent-catch", recheckable: true, gate: "code" as const, text: CATCH.text, key: CATCH.key, command: CATCH.command };
        const lintFound = { id: LINT_ID, source: "lint", recheckable: true, text: LINT.text, key: "", command: LINT.command };
        expect(state).toEqual({
            pushes: [
                {
                    project: "app",
                    id: "r2",
                    at: 20,
                    head: "h2",
                    commits: 1,
                    findings: [lintFound, { id: pushFindingId(RATCHET), source: "ratchet", recheckable: false, text: RATCHET.text, key: RATCHET.key }],
                },
                { project: "app", id: "r1", at: 10, head: "h1", commits: 2, findings: [catchFound] },
                { project: "lib", id: "r0", at: 5, head: "h0", commits: 1, findings: [{ id: pushFindingId({ source: "lint", key: "", text: "old" }), source: "lint", recheckable: true, text: "old", key: "" }] },
            ],
            reds: { app: { since: 10, findings: [catchFound, lintFound], suspects: [], named: false, decisions: [] } },
            ended: {},
            seen: ["r2", "r1", "r0"],
        });
        expect(convertDocument(pushChecksDocument.history, "object", value).changes).toEqual([]);
    });
});
