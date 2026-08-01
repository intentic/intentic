import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SyncConfig } from "./config.js";
import { type BridgeExec, bridgeRepo, listSandboxRepos, runGitBridge } from "./git-bridge.js";

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

// Stand-in object ids. Hex, because that is the shape the tip probe reads out of the `ls-remote` listing.
const TIP = "a1a1a1"; // where the sandbox's main sits
const OLD = "b2b2b2"; // a local HEAD the sandbox has moved past
const DIVERGED = "c3c3c3"; // a local HEAD carrying commits the sandbox lacks
const TIP2 = "d4d4d4"; // where the sandbox's feature branch sits

// What `ls-remote --symref sandbox HEAD` answers: the symref line, then the tip line. Both come out of the one
// round trip, which is what lets a pass decide "nothing moved" without fetching.
const SYMREF_MAIN = `ref: refs/heads/main\tHEAD\n${TIP}\tHEAD\n`;

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
                "git rev-parse -q --verify refs/remotes/sandbox/main": `${TIP}\n`,
                "git rev-parse -q --verify HEAD": undefined, // unborn — freshly initialized
                "git symbolic-ref --short -q HEAD": "main\n",
            },
            [DIR], // dir exists, dir/.git does not
        );
        bridgeRepo(exec, ALIAS, LOCAL, "proj", () => undefined);
        expect(calls).toContain("git init -q");
        expect(calls).toContain(`git remote add sandbox ${ALIAS}:/history/gits/proj`);
        expect(calls).toContain("git fetch -q sandbox +refs/heads/main:refs/remotes/sandbox/main");
        expect(calls).toContain(`git reset -q ${TIP}`);
    });

    it("URI-encodes a nested repo id in the remote url", () => {
        const { calls, exec } = scripted({ "git remote get-url": undefined, "git ls-remote": undefined }, [
            join(LOCAL, "references", "eve"),
            join(LOCAL, "references", "eve", ".git"),
        ]);
        bridgeRepo(exec, ALIAS, LOCAL, "references/eve", () => undefined);
        expect(calls).toContain(`git remote add sandbox ${ALIAS}:/history/gits/references%2Feve`);
    });

    it("fast-forwards when local HEAD is an ancestor of the sandbox tip", () => {
        const { calls, exec } = scripted(
            {
                "git remote get-url": `${ALIAS}:/history/gits/proj\n`,
                "git ls-remote": SYMREF_MAIN,
                "git rev-parse -q --verify refs/remotes/sandbox/main": `${TIP}\n`,
                "git rev-parse -q --verify HEAD": `${OLD}\n`,
                "git symbolic-ref --short -q HEAD": "main\n",
            },
            [DIR, join(DIR, ".git")],
        );
        bridgeRepo(exec, ALIAS, LOCAL, "proj", () => undefined);
        expect(calls).toContain(`git merge-base --is-ancestor HEAD ${TIP}`);
        expect(calls).toContain(`git reset -q ${TIP}`);
    });

    it("stops at the probe when the sandbox tip hasn't moved, without fetching", () => {
        const { calls, exec } = scripted(
            {
                "git remote get-url": `${ALIAS}:/history/gits/proj\n`,
                "git ls-remote": SYMREF_MAIN,
                "git rev-parse -q --verify HEAD": `${TIP}\n`,
                "git symbolic-ref --short -q HEAD": "main\n",
            },
            [DIR, join(DIR, ".git")],
        );
        bridgeRepo(exec, ALIAS, LOCAL, "proj", () => undefined);
        expect(calls.some((line) => line.startsWith("git fetch"))).toBe(false);
        expect(calls.some((line) => line.startsWith("git reset"))).toBe(false);
        // The whole quiet pass is this one round trip — which is what makes running it every tick affordable.
        expect(calls.filter((line) => line.startsWith("git ls-remote"))).toHaveLength(1);
    });

    it("still follows the sandbox's branch when HEAD already sits on its tip under another name", () => {
        const { calls, exec } = scripted(
            {
                "git remote get-url": `${ALIAS}:/history/gits/proj\n`,
                "git ls-remote": `ref: refs/heads/feature\tHEAD\n${TIP2}\tHEAD\n`,
                "git rev-parse -q --verify refs/remotes/sandbox/feature": `${TIP2}\n`,
                "git rev-parse -q --verify refs/heads/feature": undefined, // no local branch of that name yet
                "git rev-parse -q --verify HEAD": `${TIP2}\n`, // same commit, different branch name
                "git symbolic-ref --short -q HEAD": "main\n",
            },
            [DIR, join(DIR, ".git")],
        );
        bridgeRepo(exec, ALIAS, LOCAL, "proj", () => undefined);
        expect(calls).toContain("git symbolic-ref HEAD refs/heads/feature");
        expect(calls).toContain(`git reset -q ${TIP2}`);
    });

    it("never resets over local staged work", () => {
        const { calls, exec } = scripted(
            {
                "git remote get-url": `${ALIAS}:/history/gits/proj\n`,
                "git ls-remote": SYMREF_MAIN,
                "git rev-parse -q --verify refs/remotes/sandbox/main": `${TIP}\n`,
                "git rev-parse -q --verify HEAD": `${OLD}\n`,
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
                "git rev-parse -q --verify refs/remotes/sandbox/main": `${TIP}\n`,
                "git rev-parse -q --verify HEAD": `${DIVERGED}\n`,
                [`git merge-base --is-ancestor HEAD ${TIP}`]: undefined, // diverged
            },
            [DIR, join(DIR, ".git")],
        );
        bridgeRepo(exec, ALIAS, LOCAL, "proj", (message) => logs.push(message));
        expect(calls.some((line) => line.startsWith("git reset"))).toBe(false);
        expect(logs.join("\n")).toContain("diverge");
    });
});

describe("runGitBridge", () => {
    const config: SyncConfig = { sandboxUrl: "https://s.example.dev", sandboxId: "x", sshHostname: "ssh.example.dev", mode: "sync", localDir: LOCAL };
    // A mirror-only enrollment has no localDir AT ALL — the key is absent, not present-and-undefined, which
    // is the distinction the config type draws and the bridge reads.
    const { localDir: _localDir, ...withoutLocalDir } = config;

    it("reuses a repo list an earlier pass returned instead of re-listing over ssh", () => {
        const { calls, exec } = scripted({});
        expect(runGitBridge(exec, config, () => undefined, ["proj"])).toEqual(["proj"]);
        expect(calls.some((line) => line.startsWith("ssh"))).toBe(false);
    });

    it("lists over ssh when handed none, and hands the list back for the next pass", () => {
        const { calls, exec } = scripted({ ssh: "intentic\nroot\n" });
        expect(runGitBridge(exec, config, () => undefined, undefined)).toEqual(["intentic"]);
        expect(calls.some((line) => line.startsWith("ssh"))).toBe(true);
    });

    it("returns undefined when the sandbox is unreachable, so the next pass lists again", () => {
        const { exec } = scripted({ ssh: undefined });
        expect(runGitBridge(exec, config, () => undefined, undefined)).toBeUndefined();
    });

    it("does nothing for a mirror-only enrollment, which has no local tree to bridge into", () => {
        const { calls, exec } = scripted({ ssh: "intentic\n" });
        expect(runGitBridge(exec, { ...withoutLocalDir, mode: "mirror" as const }, () => undefined, undefined)).toBeUndefined();
        expect(calls).toEqual([]);
    });
});
