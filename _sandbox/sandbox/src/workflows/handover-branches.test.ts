import type { RepoBase } from "@intentic/sandbox-contract";
import type { GitRunner } from "@intentic/scaffold";
import { expect, test } from "vitest";
import { resolvedBranches } from "./handover-branches.js";

// A handover must not name a branch it has not resolved. Stubbed, not real git, since only two answers matter (a ref
// line, a count) and the throwing cases can't be reproduced by a real repo.

const ROOT = "/work";

interface RepoState {
    // Branch tip; undefined when the ref does not exist.
    readonly tip?: string;
    // Commits the branch carries over the pinned base.
    readonly ahead?: number;
    // Which read throws, when the answer is an error rather than a value.
    readonly throws?: "ref" | "count";
}

// Answers the two reads the module makes, keyed by the directory it makes them in; a lookup miss means the module
// computed a directory nobody set up.
const gitOf = (repos: Record<string, RepoState>): GitRunner => {
    const runner: GitRunner = (dir, args) => {
        const state = repos[dir];
        if (state === undefined) {
            throw new Error(`unexpected git in ${dir}: ${args.join(" ")}`);
        }
        if (args[0] === "for-each-ref") {
            if (state.throws === "ref") {
                throw new Error("cannot read refs");
            }
            return Promise.resolve({ stdout: state.tip ?? "", stderr: "" });
        }
        if (args[0] === "rev-list") {
            if (state.throws === "count") {
                throw new Error("unrelated histories");
            }
            return Promise.resolve({ stdout: `${state.ahead ?? 0}\n`, stderr: "" });
        }
        throw new Error(`unexpected git command: ${args.join(" ")}`);
    };
    return runner;
};

const repos = (...names: string[]): readonly RepoBase[] => names.map((repo) => ({ repo, base: `base-${repo}` }));

test("a repository the step never committed into is dropped from the handover", async () => {
    const git = gitOf({
        "/work": { tip: "aaa", ahead: 2 },
        "/work/site": {},
        "/work/docs": {},
    });
    const resolved = await resolvedBranches(ROOT, repos("root", "site", "docs"), "agent/abc", git);
    expect(resolved).toEqual([{ repo: "root", base: "base-root", branch: "agent/abc" }]);
});

test("a branch level with the run's base is dropped, even though the ref resolves", async () => {
    const git = gitOf({ "/work": { tip: "aaa", ahead: 0 } });
    expect(await resolvedBranches(ROOT, repos("root"), "agent/abc", git)).toEqual([]);
});

test("a step that committed nothing anywhere resolves to an empty list rather than nothing", async () => {
    const git = gitOf({ "/work": {}, "/work/site": {} });
    const resolved = await resolvedBranches(ROOT, repos("root", "site"), "agent/abc", git);
    expect(resolved).toEqual([]);
});

// Nested repos are named by their root-relative directory, root by the workspace itself.
test("repositories are read in their own checkouts, and survivors keep the given order", async () => {
    const git = gitOf({
        "/work": { tip: "aaa", ahead: 1 },
        "/work/site": {},
        "/work/packages/api": { tip: "ccc", ahead: 4 },
    });
    const resolved = await resolvedBranches(ROOT, repos("root", "site", "packages/api"), "agent/abc", git);
    expect(resolved.map(({ repo }) => repo)).toEqual(["root", "packages/api"]);
});

test("a ref read that fails drops the repository rather than naming it anyway", async () => {
    const git = gitOf({ "/work": { throws: "ref" } });
    expect(await resolvedBranches(ROOT, repos("root"), "agent/abc", git)).toEqual([]);
});

test("a count that fails keeps the branch, because the ref already proved the work is there", async () => {
    const git = gitOf({ "/work": { tip: "aaa", throws: "count" } });
    expect(await resolvedBranches(ROOT, repos("root"), "agent/abc", git)).toEqual([{ repo: "root", base: "base-root", branch: "agent/abc" }]);
});
