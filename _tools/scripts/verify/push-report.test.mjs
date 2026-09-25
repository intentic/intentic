// Pins what a push leaves behind for the daemon (push-report.mjs): which findings are recorded, the key a later
// measurement recognises them by, and the file both sides read. A key that moves with a line number would keep every
// finding open forever, and one that is too coarse would clear a finding nobody fixed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
    attributeCommits,
    brokenFindings,
    describePushes,
    distinctFindings,
    findingKey,
    measuredOf,
    readReports,
    RECHECK,
    REPORT_FILE,
    REPORTS_KEPT,
    reportPath,
    stepFindings,
    tidyFindings,
    writeReport,
} from "./push-report.mjs";
import { blindAtBase, judgeAgainstBase, problemLines } from "./turn-findings.mjs";

// The shape _tools/checks/run.mjs emits per check, with `lines` where a real one writes its findings to stderr.
const verdict = (id, lines, { ok = false, measured = true, gate = "tidy", heading = "A heading naming no location:" } = {}) => ({
    id,
    file: `${id}.mjs`,
    gate,
    ok,
    measured,
    stdout: "",
    stderr: lines.length === 0 ? "" : `${heading}\n${lines.join("\n")}\n`,
});
// What reportsAt() builds out of the base snapshot's run.
const atBase = (verdicts, lentModules) => new Map(verdicts.map((one) => [one.id, { ok: one.ok, lines: problemLines(one), blind: blindAtBase(one, lentModules) }]));

const NEW_CATCH = "  - _sandbox/sandbox/src/browser/tools/browser-router.ts:80  catch returns a literal and drops the error";
const STANDING_CATCH = "  - _sandbox/sandbox/src/files/files.ts:12  empty catch block";

test("a key survives the line moving, the count changing and the spacing, and nothing else", () => {
    assert.equal(findingKey("  foo.ts:127  .catch discards  "), "foo.ts:# .catch discards");
    assert.equal(findingKey("foo.ts:128 .catch discards"), "foo.ts:# .catch discards");
    assert.equal(findingKey("_tools/a.mjs: 3 silent catch(es), the baseline allows 2"), "_tools/a.mjs: # silent catch(es), the baseline allows #");
    assert.equal(findingKey("\tlayout:\t31 files in one directory"), "layout: # files in one directory");
    assert.equal(findingKey("foo.ts:127 .catch discards the error"), "foo.ts:# .catch discards the error");
});

test("only the tidy lines the push added are recorded: not the standing ones, not the ones the base could not be asked about", () => {
    const live = [
        verdict("silent-catch", [STANDING_CATCH, NEW_CATCH]),
        verdict("paths", ["  - docs/a.md: a path that is not there"]),
        verdict("i18n-keys", ["  - _extensions/automations/src/locales/en.json: automationsView.next"]),
    ];
    const judged = judgeAgainstBase(
        live,
        atBase(
            [
                verdict("silent-catch", [STANDING_CATCH]),
                verdict("paths", ["  - docs/a.md: a path that is not there"]),
                verdict("i18n-keys", [], { ok: true }),
            ],
            false,
        ),
    );
    // One of each: a line the push added, a check already failing the same way at the base, one the base was blind to.
    assert.deepEqual(
        judged.map(({ added, unsure }) => [added.length, unsure.length]),
        [
            [1, 0],
            [0, 0],
            [0, 1],
        ],
    );
    assert.deepEqual(tidyFindings(judged), [
        {
            kind: "check",
            check: "silent-catch",
            source: "silent-catch",
            recheckable: true,
            gate: "tidy",
            text: NEW_CATCH.trim(),
            key: "- _sandbox/sandbox/src/browser/tools/browser-router.ts:# catch returns a literal and drops the error",
            command: "node _tools/checks/run.mjs --only silent-catch",
        },
    ]);
});

test("a check that passed at the base and fails with no finding lines is recorded keyless, so only its passing clears it", () => {
    const live = [verdict("layout", ["a failure in no recognised shape"])];
    const judged = judgeAgainstBase(live, atBase([verdict("layout", [], { ok: true })], true));
    assert.deepEqual(tidyFindings(judged), [
        {
            kind: "check",
            check: "layout",
            source: "layout",
            recheckable: true,
            gate: "tidy",
            text: "layout passed before this change and fails now",
            key: "",
            command: "node _tools/checks/run.mjs --only layout",
        },
    ]);
});

test("a broken code check is one finding per line, or one keyless finding named by its first line", () => {
    assert.deepEqual(brokenFindings(verdict("hooks-armed", [NEW_CATCH], { gate: "code" })), [
        {
            kind: "check",
            check: "hooks-armed",
            source: "hooks-armed",
            recheckable: true,
            gate: "code",
            command: "node _tools/checks/run.mjs --only hooks-armed",
            text: NEW_CATCH.trim(),
            key: findingKey(NEW_CATCH),
        },
    ]);
    assert.deepEqual(brokenFindings(verdict("lockfile", ["the lockfile no longer records the manifest"], { gate: "code", heading: "" })), [
        {
            kind: "check",
            check: "lockfile",
            source: "lockfile",
            recheckable: true,
            gate: "code",
            command: "node _tools/checks/run.mjs --only lockfile",
            text: "the lockfile no longer records the manifest",
            key: "",
        },
    ]);
    assert.deepEqual(
        brokenFindings(verdict("lockfile", [], { gate: "code" })).map(({ text, key }) => ({ text, key })),
        [{ text: "lockfile fails", key: "" }],
    );
});

test("the steps that are findings of their own are named by kind; the checks' steps are already recorded line by line", () => {
    const failed = [
        { label: "checkout gates", why: "1 check(s) the tree fails: hooks-armed · node _tools/checks/run.mjs --only hooks-armed" },
        { label: "tidiness", why: "1 tidy check(s) this push breaks: paths" },
        { label: "assertion ratchet (0123abcde..4567fedcb)", why: "exit 1", spelling: "node _tools/scripts/verify/assertion-ratchet.mjs 0123abcde 4567fedcb" },
        { label: "manifest/lockfile lockstep", why: "the push commits package.json while pnpm-lock.yaml is changed" },
        { label: "lint", why: "exit 1", spelling: "pnpm lint" },
        { label: "cargo fmt --check (tools/ic)", why: "exit 1", spelling: "cargo fmt --manifest-path tools/ic/Cargo.toml --all --check" },
    ];
    assert.deepEqual(stepFindings(failed), [
        {
            kind: "ratchet",
            source: "ratchet",
            recheckable: false,
            text: "assertion ratchet (0123abcde..4567fedcb): exit 1",
            key: "assertion ratchet (#abcde..#fedcb): exit #",
            command: "node _tools/scripts/verify/assertion-ratchet.mjs 0123abcde 4567fedcb",
        },
        {
            kind: "lockstep",
            source: "lockstep",
            recheckable: false,
            text: "manifest/lockfile lockstep: the push commits package.json while pnpm-lock.yaml is changed",
            key: "manifest/lockfile lockstep: the push commits package.json while pnpm-lock.yaml is changed",
        },
        { kind: "lint", source: "lint", recheckable: true, text: "lint: exit 1", key: "", command: "pnpm lint" },
        {
            kind: "rustfmt",
            source: "rustfmt",
            recheckable: false,
            text: "cargo fmt --check (tools/ic): exit 1",
            key: "cargo fmt --check (tools/ic): exit #",
            command: "cargo fmt --manifest-path tools/ic/Cargo.toml --all --check",
        },
    ]);
});

test("two lines that differ only in their digits are one finding, and keyless ones are told apart by their text", () => {
    const finding = (text, key) => ({ kind: "check", check: "silent-catch", gate: "tidy", text, key });
    const summary = finding("- a.ts: 3 silent catch(es), the baseline allows 2", findingKey("- a.ts: 3 silent catch(es), the baseline allows 2"));
    const again = finding("- a.ts: 4 silent catch(es), the baseline allows 3", findingKey("- a.ts: 4 silent catch(es), the baseline allows 3"));
    const lint = { kind: "lint", text: "lint: exit 1", key: "" };
    const whole = finding("silent-catch passed before this change and fails now", "");
    assert.deepEqual(distinctFindings([summary, again, lint, whole, { ...whole }]), [summary, lint, whole]);
});

test("the measurement keys every check the way findings are keyed, and says which ones could not look", () => {
    const moved = NEW_CATCH.replace(":80", ":81");
    const measured = measuredOf(
        [
            verdict("paths", [], { ok: true }),
            verdict("silent-catch", [NEW_CATCH, moved, STANDING_CATCH]),
            verdict("i18n-literals", [], { measured: false }),
        ],
        "failed",
    );
    assert.deepEqual(measured, {
        checks: {
            paths: { ok: true, measured: true, keys: [] },
            "silent-catch": { ok: false, measured: true, keys: [findingKey(NEW_CATCH), findingKey(STANDING_CATCH)] },
            "i18n-literals": { ok: false, measured: false, keys: [] },
        },
        lint: "failed",
    });
    assert.deepEqual(measuredOf(undefined, undefined), { checks: {} });
});

// A real repository, since what is under test is where git puts the file and what `git log` answers for a range.
const git = (cwd, ...args) => {
    const result = spawnSync("git", ["-c", "user.name=push-report", "-c", "user.email=push-report@example.invalid", "-c", "commit.gpgsign=false", ...args], {
        cwd,
        encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
};
const commit = (cwd, files, subject) => {
    for (const [path, text] of Object.entries(files)) {
        writeFileSync(join(cwd, path), text);
    }
    git(cwd, "add", "-A");
    git(cwd, "commit", "-q", "--no-verify", "-m", subject);
    return git(cwd, "rev-parse", "HEAD");
};
const repository = (body) => {
    const root = mkdtempSync(join(tmpdir(), "push-report-"));
    try {
        git(root, "init", "-q");
        body(root);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
};

test("the report sits in the git common dir, newest first, cut to what is kept, and a corrupt one is started over", () => {
    repository((root) => {
        assert.equal(reportPath(root), join(realpathSync(root), ".git", REPORT_FILE));
        assert.deepEqual(readReports(root), []);
        const entry = (n) => ({ version: 1, id: `r${n}`, at: n, kind: "recheck", measured: { checks: {} }, recheck: RECHECK });
        for (let n = 1; n <= REPORTS_KEPT + 2; n += 1) {
            assert.deepEqual(writeReport(root, entry(n)), { ok: true, path: reportPath(root) });
        }
        assert.deepEqual(
            readReports(root).map(({ id }) => id),
            ["r12", "r11", "r10", "r9", "r8", "r7", "r6", "r5", "r4", "r3"],
        );
        writeFileSync(reportPath(root), "[{ half a report");
        assert.deepEqual(writeReport(root, entry(13)), { ok: true, path: reportPath(root) });
        assert.deepEqual(readReports(root), [entry(13)]);
    });
});

test("a finding names the newest pushed commit that touched its path, and nothing outside the range or the repository", () => {
    repository((root) => {
        const base = commit(root, { "a.ts": "a\n", "b.ts": "b\n" }, "chore: start");
        const touched = commit(root, { "a.ts": "a2\n" }, "feat: touch a");
        const head = commit(root, { "README.md": "readme\n" }, "docs: readme");
        const short = git(root, "log", "-1", "--format=%h", touched);
        const findings = [
            { kind: "check", text: "- a.ts:12  catch returns a literal", key: "" },
            { kind: "check", text: "- b.ts:3  untouched by the push", key: "" },
            { kind: "check", text: "portability/definition.ts:18 relative to a package", key: "" },
        ];
        const pushes = describePushes(root, [{ ref: "refs/heads/main", head, base }]);
        assert.deepEqual(pushes, [{ ref: "refs/heads/main", head, base, commits: 2 }]);
        assert.deepEqual(
            attributeCommits(root, findings, pushes).map(({ commit: named }) => named),
            [{ sha: short, subject: "feat: touch a" }, undefined, undefined],
        );
        assert.deepEqual(attributeCommits(root, findings, describePushes(root, [{ ref: "refs/heads/main", head }])), findings);
        assert.deepEqual(describePushes(root, [{ ref: "refs/heads/main", head }]), [{ ref: "refs/heads/main", head, commits: 0 }]);
        // Out of git calls, the rest go unnamed rather than slowing the push.
        assert.deepEqual(
            attributeCommits(root, [findings[1], findings[0]], pushes, 1).map(({ commit: named }) => named),
            [undefined, undefined],
        );
    });
});
