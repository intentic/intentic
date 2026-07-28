import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type BridgeExec, bridgeRepo, listSandboxRepos } from "./git-bridge.js";

// A scripted BridgeExec: `handlers` maps a command-line PREFIX to its stdout (undefined = that command fails),
// first match wins, anything unscripted succeeds with empty output. `existing` is the fake filesystem.
const scripted = (handlers: Record<string, string | undefined>, existing: readonly string[] = []) => {
    const calls: string[] = [];
    const paths = new Set(existing);
    const exec: BridgeExec = {
        run: (command, args) => {
            const line = [command, ...args].join(" ");
            calls.push(line);
            for (const [prefix, out] of Object.entries(handlers)) {
                if (line.startsWith(prefix)) {
                    return out;
                }
            }
            return "";
        },
        exists: (path) => paths.has(path),
    };
    return { calls, exec };
};

const ALIAS = "intentic-sync-x";
const LOCAL = join("/", "home", "u", "sandbox");
const DIR = join(LOCAL, "proj");
const SYMREF_MAIN = "ref: refs/heads/main\tHEAD\nabc\tHEAD\n";

describe("listSandboxRepos", () => {
    it("decodes the git-dir names, drops root, and refuses ids that could escape the local dir", () => {
        const { exec } = scripted({
            ssh: "root\nintentic\nreferences%2Feve\n..%2F..%2Fetc\n.hidden\n\n",
        });
        expect(listSandboxRepos(exec, ALIAS)).toEqual(["intentic", "references/eve"]);
    });

    it("reports an unreachable sandbox as undefined rather than an empty repo set", () => {
        const { exec } = scripted({ ssh: undefined });
        expect(listSandboxRepos(exec, ALIAS)).toBeUndefined();
    });
});

describe("bridgeRepo", () => {
    it("does nothing while the worktree hasn't synced down yet", () => {
        const { calls, exec } = scripted({});
        bridgeRepo(exec, ALIAS, LOCAL, "proj", () => undefined);
        expect(calls).toEqual([]);
    });

    it("bootstraps a repo born in the sandbox: init, remote, fetch, then a mixed reset to the sandbox tip", () => {
        const { calls, exec } = scripted(
            {
                "git remote get-url": undefined, // no remote yet
                "git ls-remote": SYMREF_MAIN,
                "git rev-parse -q --verify refs/remotes/sandbox/main": "tip1\n",
                "git rev-parse -q --verify HEAD": undefined, // unborn — freshly initialized
                "git symbolic-ref --short -q HEAD": "main\n",
            },
            [DIR], // dir exists, dir/.git does not
        );
        bridgeRepo(exec, ALIAS, LOCAL, "proj", () => undefined);
        expect(calls).toContain("git init -q");
        expect(calls).toContain(`git remote add sandbox ${ALIAS}:/history/gits/proj`);
        expect(calls).toContain("git fetch -q sandbox +refs/heads/main:refs/remotes/sandbox/main");
        expect(calls).toContain("git reset -q tip1");
    });

    it("URI-encodes a nested repo id in the remote url", () => {
        const { calls, exec } = scripted(
            { "git remote get-url": undefined, "git ls-remote": undefined },
            [join(LOCAL, "references", "eve"), join(LOCAL, "references", "eve", ".git")],
        );
        bridgeRepo(exec, ALIAS, LOCAL, "references/eve", () => undefined);
        expect(calls).toContain(`git remote add sandbox ${ALIAS}:/history/gits/references%2Feve`);
    });

    it("fast-forwards when local HEAD is an ancestor of the sandbox tip", () => {
        const { calls, exec } = scripted(
            {
                "git remote get-url": `${ALIAS}:/history/gits/proj\n`,
                "git ls-remote": SYMREF_MAIN,
                "git rev-parse -q --verify refs/remotes/sandbox/main": "tip1\n",
                "git rev-parse -q --verify HEAD": "old1\n",
                "git symbolic-ref --short -q HEAD": "main\n",
            },
            [DIR, join(DIR, ".git")],
        );
        bridgeRepo(exec, ALIAS, LOCAL, "proj", () => undefined);
        expect(calls).toContain("git merge-base --is-ancestor HEAD tip1");
        expect(calls).toContain("git reset -q tip1");
    });

    it("leaves an already-current repo alone", () => {
        const { calls, exec } = scripted(
            {
                "git remote get-url": `${ALIAS}:/history/gits/proj\n`,
                "git ls-remote": SYMREF_MAIN,
                "git rev-parse -q --verify refs/remotes/sandbox/main": "tip1\n",
                "git rev-parse -q --verify HEAD": "tip1\n",
                "git symbolic-ref --short -q HEAD": "main\n",
            },
            [DIR, join(DIR, ".git")],
        );
        bridgeRepo(exec, ALIAS, LOCAL, "proj", () => undefined);
        expect(calls.some((line) => line.startsWith("git reset"))).toBe(false);
    });

    it("never resets over local staged work", () => {
        const { calls, exec } = scripted(
            {
                "git remote get-url": `${ALIAS}:/history/gits/proj\n`,
                "git ls-remote": SYMREF_MAIN,
                "git rev-parse -q --verify refs/remotes/sandbox/main": "tip1\n",
                "git rev-parse -q --verify HEAD": "old1\n",
                "git diff --cached --quiet": undefined, // something is staged
            },
            [DIR, join(DIR, ".git")],
        );
        bridgeRepo(exec, ALIAS, LOCAL, "proj", () => undefined);
        expect(calls.some((line) => line.startsWith("git reset"))).toBe(false);
    });

    it("never resets local commits the sandbox lacks", () => {
        const logs: string[] = [];
        const { calls, exec } = scripted(
            {
                "git remote get-url": `${ALIAS}:/history/gits/proj\n`,
                "git ls-remote": SYMREF_MAIN,
                "git rev-parse -q --verify refs/remotes/sandbox/main": "tip1\n",
                "git rev-parse -q --verify HEAD": "local1\n",
                "git merge-base --is-ancestor HEAD tip1": undefined, // diverged
            },
            [DIR, join(DIR, ".git")],
        );
        bridgeRepo(exec, ALIAS, LOCAL, "proj", (message) => logs.push(message));
        expect(calls.some((line) => line.startsWith("git reset"))).toBe(false);
        expect(logs.join("\n")).toContain("diverge");
    });

    it("follows a sandbox branch switch by moving HEAD without touching files", () => {
        const { calls, exec } = scripted(
            {
                "git remote get-url": `${ALIAS}:/history/gits/proj\n`,
                "git ls-remote": "ref: refs/heads/feature\tHEAD\nabc\tHEAD\n",
                "git rev-parse -q --verify refs/remotes/sandbox/feature": "tip2\n",
                "git rev-parse -q --verify refs/heads/feature": undefined, // no local branch of that name yet
                "git rev-parse -q --verify HEAD": "tip2\n", // same commit, different branch name
                "git symbolic-ref --short -q HEAD": "main\n",
            },
            [DIR, join(DIR, ".git")],
        );
        bridgeRepo(exec, ALIAS, LOCAL, "proj", () => undefined);
        expect(calls).toContain("git symbolic-ref HEAD refs/heads/feature");
        expect(calls).toContain("git reset -q tip2");
    });
});
