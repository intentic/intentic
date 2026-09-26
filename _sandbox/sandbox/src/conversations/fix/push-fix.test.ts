import { type Finding, type MainlinePush, pushFixBase, pushFixConversationId, type Red } from "@intentic/sandbox-contract";
import { pushFixBrief } from "./push-fix.js";

// What an agent handed a project's push findings opens on: it knows nothing else, so the words are the subject here.
// The linter's finding keeps the "- " bullet some checks print, as the hook reports it verbatim.
// Which conversation it lands in (continue, start over, busy) is fix-attempts.test.ts's.

const PUSHES: readonly MainlinePush[] = [
    {
        project: "app",
        id: "r2",
        at: 20,
        remote: "origin",
        branch: "main",
        head: "2222222aaaa",
        commits: 1,
        findings: [
            { id: "lint:x", source: "lint", recheckable: true, text: "- src/b.ts:4 no-unused-vars", command: "node _tools/oxlint/lint-edit.mjs src/b.ts" },
        ],
    },
    { project: "lib", id: "q1", at: 15, head: "9999999", commits: 1, findings: [{ id: "lint:y", source: "lint", recheckable: true, text: "elsewhere" }] },
    {
        project: "app",
        id: "r1",
        at: 10,
        remote: "origin",
        branch: "main",
        base: "0000000bbbb",
        head: "1111111cccc",
        commits: 2,
        findings: [
            {
                id: "silent-catch:a",
                source: "silent-catch",
                recheckable: true,
                gate: "tidy",
                text: "src/a.ts:1 empty catch block",
                command: "node _tools/checks/run.mjs --only silent-catch",
                commit: { sha: "1111111cccc", subject: "feat: read the report" },
            },
            {
                id: "paths:b",
                source: "paths",
                recheckable: true,
                gate: "code",
                text: "docs/x.md links a missing file",
                command: "node _tools/checks/run.mjs --only paths",
            },
            {
                id: "ratchet:c",
                source: "ratchet",
                recheckable: false,
                text: "src/a.test.ts: toEqual became toMatchObject",
                commit: { sha: "0aaaaaa1234", subject: "test: loosen the fixture" },
            },
            { id: "paths:d", source: "paths", recheckable: true, gate: "code", text: "gone already" },
        ],
    },
];

// A project's push red as the store keeps it: what its pushes found and still owe, in the order they were filed.
const redOf = (pushes: readonly MainlinePush[], project: string, since: number, settled: readonly string[] = []): Red => ({
    source: "push",
    scope: project,
    since,
    findings: pushes
        .filter((push) => push.project === project)
        .toReversed()
        .flatMap((push): Finding[] => push.findings)
        .filter((finding) => !settled.includes(finding.id)),
    suspects: [],
    named: false,
    decisions: [],
});
// `app` owes all but what a measurement found gone.
const APP = redOf(PUSHES, "app", 10, ["paths:d"]);

describe("the brief a push-fix conversation opens on", () => {
    test("names the pushed ranges oldest first, then every open finding grouped by what printed it, code-gate checks first", () => {
        expect(pushFixBrief(PUSHES, APP)?.prompt).toBe(
            [
                "The push check in `app` let the findings below through. It only reports, so nothing blocked the push, and they still stand.",
                "What was pushed:\n- `0000000..1111111` to origin/main, 2 commits\n  - 1111111 feat: read the report\n  - 0aaaaaa test: loosen the fixture\n- `2222222` (the remote had nothing to compare it with) to origin/main, 1 commit",
                "What it found, by what measured it:",
                "`paths`, which the tree fails whoever caused it:\n- docs/x.md links a missing file\n  `node _tools/checks/run.mjs --only paths`",
                "`silent-catch`, on lines the push added:\n- src/a.ts:1 empty catch block\n  `node _tools/checks/run.mjs --only silent-catch`",
                "`lint`:\n- src/b.ts:4 no-unused-vars\n  `node _tools/oxlint/lint-edit.mjs src/b.ts`",
                "`ratchet`, about the pushed commits themselves:\n- src/a.test.ts: toEqual became toMatchObject",
                "Fix them in the code, and confirm each one by re-running the command next to it. The owner's Main line clears a finding once a measurement no longer prints it.",
                "Findings about the pushed commits themselves concern commits that are already pushed, so their fix is a follow-up commit.",
                "You are in an isolated worktree: commit your fix and it goes through review.",
            ].join("\n\n"),
        );
    });

    // Any repository's tooling names what measured a finding: the brief groups by that name and whether a measurement can
    // clear it, never by a list of this repository's own checks.
    test("groups a finding by the source its repository named, and by whether a measurement can clear it", () => {
        const generic: MainlinePush = {
            project: "svc",
            id: "g1",
            at: 30,
            head: "3333333dddd",
            commits: 1,
            findings: [
                { id: "mypy:a", source: "mypy", recheckable: true, text: "svc/a.py:3 error", command: "make typecheck" },
                { id: "signoff:b", source: "signoff", recheckable: false, text: "commit 3333333 is not signed off" },
            ],
        };

        const prompt = pushFixBrief([generic], redOf([generic], "svc", 30))?.prompt ?? "";

        expect(prompt).toContain("`mypy`:\n- svc/a.py:3 error\n  `make typecheck`\n\n`signoff`, about the pushed commits themselves:\n- commit 3333333 is not signed off");
        expect(prompt).toContain("Findings about the pushed commits themselves concern commits that are already pushed, so their fix is a follow-up commit.");
    });

    // The push the repository's own hook refused is filed beside what pushes left (push-checks-store.ts, fileRefusal), so
    // its fix is the same hand-over, opening on what the hook said.
    test("opens on a refused push with the hook's own words and how to confirm the fix without sending anything", () => {
        const refused: MainlinePush = {
            project: "app",
            id: "refused-x",
            at: 40,
            remote: "origin",
            branch: "main",
            head: "4444444eeee",
            commits: 0,
            refused: true,
            findings: [{ id: "pre-push:z", source: "pre-push", recheckable: false, text: "typecheck failed", command: "git push --dry-run" }],
        };

        const brief = pushFixBrief([refused], redOf([refused], "app", 40));

        expect(brief?.prompt).toBe(
            [
                "The push of `4444444` to origin/main was refused by the repository's own pre-push hook, so nothing reached the remote. What it said (the end of it):",
                "```\ntypecheck failed\n```",
                "Find the cause and fix it, then confirm the hook passes: `git push --dry-run` runs it without sending anything.",
                "You are in an isolated worktree: commit your fix and it goes through review.",
            ].join("\n\n"),
        );
        expect(brief?.base).toBe(pushFixConversationId("app", "red:40"));
    });

    test("says nothing of already-pushed commits when every open finding can be measured again", () => {
        expect(pushFixBrief(PUSHES, redOf(PUSHES, "app", 10, ["paths:d", "ratchet:c"]))?.prompt.includes("follow-up commit")).toBe(false);
    });

    test("nudges a continued attempt with what is still open, and is keyed by when the red began", () => {
        const brief = pushFixBrief(PUSHES, APP);

        expect(brief?.nudge).toBe(
            [
                "What the push check let through in `app` is not all fixed yet, and this conversation is the attempt at it. Still open:",
                "- src/a.ts:1 empty catch block\n- docs/x.md links a missing file\n- src/a.test.ts: toEqual became toMatchObject\n- src/b.ts:4 no-unused-vars",
                "Carry on from where you left off, and confirm each one with the command next to it earlier in this conversation.",
            ].join("\n\n"),
        );
        expect(brief?.title).toBe("Fix what the push left: app");
        expect(brief?.base).toBe(pushFixConversationId("app", "red:10"));
        expect(brief?.base).toBe(pushFixBase(APP));
    });

    test("names the workspace root by what it is, and has nothing to hand over where nothing is open", () => {
        const root = PUSHES.map((push) => ({ ...push, project: push.project === "lib" ? "" : push.project }));

        const rootRed = redOf(root, "", 15);

        expect(pushFixBrief(root, rootRed)?.title).toBe("Fix what the push left: workspace");
        expect(pushFixBrief(root, rootRed)?.prompt.startsWith("The push check in the workspace root let the findings below through.")).toBe(true);
        expect(pushFixBrief(PUSHES, undefined)).toBeUndefined();
        expect(pushFixBrief(PUSHES, { ...APP, findings: [] })).toBeUndefined();
    });
});
