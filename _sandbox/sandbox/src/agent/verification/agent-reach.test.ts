import { STATE_DIR, WORKSPACE_ROOT } from "@intentic/constants";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { composeReach, createReachFrameLedger, livePathOf, pushesIn, type ReachParts } from "./agent-reach.js";

// The frames' half of a turn's reach (AgentSummary.reach): which paths an edit tool wrote are live rather than on the
// turn's branch, and which shell commands pushed with git. Inside an isolated turn's namespace its worktree IS /work, so
// a live path arrives looking like any other workspace path and only the shared-state prefixes tell it apart.

const ROOT = WORKSPACE_ROOT;

describe("which written paths are live", () => {
    test.each([
        [`${STATE_DIR}/local/extensions/intentic-x/src/a.ts`, `${STATE_DIR}/local/extensions/intentic-x/src/a.ts`],
        [`./${STATE_DIR}/local/state.json`, `${STATE_DIR}/local/state.json`],
        [`${WORKSPACE_ROOT}/${STATE_DIR}/local/extensions/intentic-x/src/a.ts`, `${STATE_DIR}/local/extensions/intentic-x/src/a.ts`],
        ["/mnt/intentic-main/intentic/src/app.ts", "/mnt/intentic-main/intentic/src/app.ts"],
        ["/mnt/intentic-main/.intentic/config/settings.json", "/mnt/intentic-main/.intentic/config/settings.json"],
        // The owner's checkout IS the workspace: its shared state is named the one way, however the turn reached it.
        ["/mnt/intentic-main/.intentic/local/extensions/intentic-x/src/a.ts", `${STATE_DIR}/local/extensions/intentic-x/src/a.ts`],
    ])("%s is live, as %s", (path, live) => {
        expect(livePathOf(path, ROOT)).toBe(live);
    });

    // The turn's own files, the state that is shared but nobody's work (records, identity), and anything outside the tree.
    test.each([
        "src/app.ts",
        `${WORKSPACE_ROOT}/intentic/src/app.ts`,
        `${STATE_DIR}/records/artifacts/shot.png`,
        `${WORKSPACE_ROOT}/${STATE_DIR}/records/history.json`,
        `${STATE_DIR}/config/settings.json`,
        `${STATE_DIR}/identity/owner.json`,
        "/tmp/scratch.txt",
        "../elsewhere/file.ts",
        "/mnt/intentic-mainline/file.ts",
        `/mnt/intentic-main/${STATE_DIR}/records/artifacts/shot.png`,
    ])("%s is not", (path) => {
        expect(livePathOf(path, ROOT)).toBeUndefined();
    });
});

describe("which commands push", () => {
    test("a plain push, from the turn's own folder, to wherever its branch goes", () => {
        expect(pushesIn("git push")).toStrictEqual([{ command: "git push" }]);
    });

    test("names the folder from -C, and the remote and branch from its arguments", () => {
        expect(pushesIn("git -C extensions/x push origin main")).toStrictEqual([
            { dir: "extensions/x", remote: "origin", branch: "main", command: "git -C extensions/x push origin main" },
        ]);
    });

    test("names the folder from a cd that opens the line", () => {
        expect(pushesIn("cd extensions/x && git push")).toStrictEqual([{ dir: "extensions/x", command: "git push" }]);
        expect(pushesIn("cd /work/repo && pnpm test && git push -u origin HEAD:refs/heads/fix")).toStrictEqual([
            { dir: `${WORKSPACE_ROOT}/repo`, remote: "origin", branch: "fix", command: "git push -u origin HEAD:refs/heads/fix" },
        ]);
    });

    test("reads the branch a refspec writes, past a force mark", () => {
        expect(pushesIn("git push --force-with-lease upstream +feature")).toStrictEqual([
            { remote: "upstream", branch: "feature", command: "git push --force-with-lease upstream +feature" },
        ]);
    });

    test("finds every push on the line, and a push run through a shell", () => {
        expect(pushesIn("git push origin a; git -C b push origin c").map((push) => push.command)).toStrictEqual([
            "git push origin a",
            "git -C b push origin c",
        ]);
        expect(pushesIn("bash -c 'git push origin main'")).toHaveLength(1);
    });

    // Text a program only prints or matches, and a push that sends nothing, published nothing.
    test.each([
        `echo "git push origin main"`,
        `git commit -m "then git push it"`,
        `rg "git push" docs`,
        "git push --dry-run origin main",
        "git status",
        "git stash push -m wip",
        "git-push-helper",
    ])("%s does not", (command) => {
        expect(pushesIn(command)).toStrictEqual([]);
    });
});

const call = (id: string, event: Partial<Extract<AgentEvent, { kind: "tool_call" }>>): AgentEvent => ({
    kind: "tool_call",
    id,
    name: "Edit",
    category: "edit",
    status: "in_progress",
    ...event,
});
const settled = (id: string, status: "completed" | "failed", text?: string): AgentEvent => ({
    kind: "tool_call_update",
    id,
    status,
    ...(text === undefined ? {} : { content: [{ type: "text" as const, text }] }),
});

describe("the frame ledger", () => {
    test("keeps the live paths an edit wrote once it completed, whichever way the runtime named them", () => {
        const ledger = createReachFrameLedger(ROOT);
        ledger.note(call("1", { locations: [{ path: `${STATE_DIR}/local/extensions/intentic-x/src/a.ts` }, { path: "src/own.ts" }] }));
        ledger.note(settled("1", "completed"));
        // Claude keeps a path outside the tree only on its diff; Codex only in its target.
        ledger.note(call("2", { content: [{ type: "diff", path: "/mnt/intentic-main/intentic/a.ts", newText: "x" }], status: "completed" }));
        ledger.note(call("3", { target: "update /mnt/intentic-main/intentic/b.ts, add src/c.ts", status: "completed" }));
        ledger.note(call("4", { category: "delete", target: "delete .intentic/local/state.json", status: "completed" }));
        expect(ledger.reading().live).toStrictEqual([
            `${STATE_DIR}/local/extensions/intentic-x/src/a.ts`,
            "/mnt/intentic-main/intentic/a.ts",
            "/mnt/intentic-main/intentic/b.ts",
            `${STATE_DIR}/local/state.json`,
        ]);
    });

    test("drops a write that failed, and one never answered", () => {
        const ledger = createReachFrameLedger(ROOT);
        ledger.note(call("1", { locations: [{ path: `${STATE_DIR}/local/state.json` }] }));
        ledger.note(settled("1", "failed"));
        ledger.note(call("2", { locations: [{ path: `${STATE_DIR}/local/other.json` }] }));
        expect(ledger.reading().live).toStrictEqual([]);
    });

    test("counts a push whose command went through, by its exit footer before its status", () => {
        const ledger = createReachFrameLedger(ROOT);
        const bash = (id: string, command: string): AgentEvent => call(id, { name: "Bash", category: "execute", target: command });
        ledger.note(bash("1", "git push origin main"));
        ledger.note(settled("1", "completed", "To github.com:x/y.git\n--- [exit 0, 1s]"));
        ledger.note(bash("2", "git -C a push origin b"));
        ledger.note(settled("2", "completed", "rejected\n--- [exit 1, 1s]"));
        ledger.note(bash("3", "cd c && git push"));
        ledger.note(settled("3", "failed"));
        ledger.note(bash("4", "git push origin main"));
        ledger.note(settled("4", "completed"));
        expect(ledger.reading().published).toStrictEqual([{ remote: "origin", branch: "main", command: "git push origin main" }]);
    });
});

describe("the reach a card shows", () => {
    const parts = (change: Partial<ReachParts>): ReachParts => ({
        framed: { live: [], published: [] },
        installs: [],
        covered: new Set(),
        stranded: [],
        ...change,
    });

    test("is nothing at all for a turn whose work stayed on its branch", () => {
        expect(composeReach(parts({}), 1_000)).toBeUndefined();
    });

    test("lets git speak for an install it read, and the frames for one it could not", () => {
        const reach = composeReach(
            parts({
                framed: {
                    live: [
                        `${STATE_DIR}/local/extensions/read/src/a.ts`,
                        `${STATE_DIR}/local/extensions/unread/src/b.ts`,
                        `${STATE_DIR}/local/state.json`,
                    ],
                    published: [],
                },
                installs: [{ dir: "shelled", extension: "intentic.shelled" }],
                covered: new Set(["read", "shelled"]),
            }),
            1_000,
        );
        expect(reach).toStrictEqual({
            at: 1_000,
            live: [
                { path: `${STATE_DIR}/local/extensions/shelled`, extension: "intentic.shelled" },
                { path: `${STATE_DIR}/local/extensions/unread/src/b.ts` },
                { path: `${STATE_DIR}/local/state.json` },
            ],
        });
    });

    test("caps each list and counts what it left out", () => {
        const live = Array.from({ length: 13 }, (_, index) => `${STATE_DIR}/local/f${index}.json`);
        const stranded = Array.from({ length: 11 }, (_, index) => ({ dir: `clone${index}`, uncommitted: 1, unpushed: 0 }));
        const reach = composeReach(parts({ framed: { live, published: [{ command: "git push" }] }, stranded }), 1_000);
        expect(reach?.live).toHaveLength(10);
        expect(reach?.liveMore).toBe(3);
        expect(reach?.stranded).toHaveLength(10);
        expect(reach?.strandedMore).toBe(1);
        expect(reach?.published).toStrictEqual([{ command: "git push" }]);
        expect(reach?.publishedMore).toBeUndefined();
    });
});
