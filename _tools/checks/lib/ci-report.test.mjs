import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ANNOTATION_LIMIT, annotation, createReporter, locate } from "./ci-report.mjs";

test("locate reads the finding shapes the checks and oxlint print", () => {
    assert.deepEqual(locate("  - _editor/web/src/a/SealedCard.vue:89: agents.card.count — no catalog this file reads has it"), {
        file: "_editor/web/src/a/SealedCard.vue",
        line: 89,
        message: "agents.card.count — no catalog this file reads has it",
    });
    assert.deepEqual(locate("_editor/web/src/SealPill.vue:45  `gap-1.5` overrides what `ui.textButton()` owns"), {
        file: "_editor/web/src/SealPill.vue",
        line: 45,
        message: "`gap-1.5` overrides what `ui.textButton()` owns",
    });
    assert.deepEqual(locate("_tools/a.ts:12:5: Unexpected any [Error/typescript(no-explicit-any)]"), {
        file: "_tools/a.ts",
        line: 12,
        col: 5,
        message: "Unexpected any [Error/typescript(no-explicit-any)]",
    });
    assert.deepEqual(locate("  _sandbox/x/switch-account.test.ts: downgrade (exact 28→26)"), {
        file: "_sandbox/x/switch-account.test.ts",
        message: "downgrade (exact 28→26)",
    });
    assert.equal(locate("silent-catch: the tree beats baselines/silent-catch.json"), undefined);
    assert.equal(locate("checks: 71 passed in 1.2s"), undefined);
    assert.equal(locate(""), undefined);
});

test("annotation escapes what a workflow command would otherwise misread", () => {
    assert.equal(
        annotation("i18n-keys, a check", { file: "a:b.ts", line: 3, message: "50% off\nnext" }),
        "::warning file=a%3Ab.ts,line=3,title=i18n-keys%2C a check::50%25 off%0Anext",
    );
});

test("the reporter is silent outside GitHub Actions", () => {
    const written = [];
    const { annotate, summary } = createReporter({ env: {}, write: (text) => written.push(text) });
    assert.equal(annotate("lint", ["a.ts:1:1: x [Error/r]"]), 0);
    summary("lint", "why", ["a"]);
    assert.deepEqual(written, []);
});

test("inside Actions it annotates up to the limit and writes the summary", () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-report-"));
    try {
        const file = join(dir, "summary.md");
        const written = [];
        const { annotate, summary } = createReporter({ env: { GITHUB_ACTIONS: "true", GITHUB_STEP_SUMMARY: file }, write: (text) => written.push(text) });
        const lines = Array.from({ length: ANNOTATION_LIMIT + 3 }, (_, at) => `src/f${at}.ts:${at + 1}: finding ${at}`);
        assert.equal(annotate("code-shape", ["a header line", ...lines]), ANNOTATION_LIMIT);
        assert.equal(written.length, ANNOTATION_LIMIT);
        assert.equal(written[0], "::warning file=src/f0.ts,line=1,title=code-shape::finding 0\n");
        assert.equal(annotate("more", ["src/g.ts:1: past the limit"]), 0);
        summary("code-shape", "reported, not failed", lines);
        const text = readFileSync(file, "utf8");
        assert.match(text, /#### code-shape\nreported, not failed\n```\nsrc\/f0\.ts:1: finding 0/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
