import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Pairing } from "./config.js";
import { type BridgeExec, bridgeRepo, listSandboxRepos, runGitBridge } from "./git-bridge.js";

// A scripted BridgeExec: `handlers` maps a command-line PREFIX to its stdout (undefined = that command fails),
// first match wins, anything unscripted succeeds with empty output. `existing` is the fake filesystem. An ARRAY
// answers successive calls of the same command in order (the last entry repeats): the bridge reads the
// sandbox's remote-tracking ref both before and after a fetch, and the two readings are the whole point.
const scripted = (handlers: Record<string, string | undefined | readonly (string | undefined)[]>, existing: readonly string[] = []) => {
    const calls: string[] = [];
    const paths = new Set(existing);
    const seen = new Map<string, number>();
    const exec: BridgeExec = {
        run: async (command, args) => {
            const line = [command, ...args].join(" ");
            calls.push(line);
            for (const [prefix, out] of Object.entries(handlers)) {
                if (line.startsWith(prefix)) {
                    if (!Array.isArray(out)) {
                        return await Promise.resolve(out as string | undefined);
                    }
                    const nth = seen.get(prefix) ?? 0;
                    seen.set(prefix, nth + 1);
                    return await Promise.resolve(out[Math.min(nth, out.length - 1)]);
                }
            }
            return await Promise.resolve("");
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
    it("decodes the git-dir names, drops root, and refuses ids that could escape the local dir", async () => {
        const { exec } = scripted({
            ssh: "root\nintentic\nreferences%2Feve\n..%2F..%2Fetc\n.hidden\n\n",
        });
        expect(await listSandboxRepos(exec, ALIAS)).toEqual(["intentic", "references/eve"]);
    });

    it("reports an unreachable sandbox as undefined rather than an empty repo set", async () => {
        const { exec } = scripted({ ssh: undefined });
        expect(await listSandboxRepos(exec, ALIAS)).toBeUndefined();
    });
});

describe("bridgeRepo", () => {
    it("does nothing while the worktree hasn't synced down yet", async () => {
        const { calls, exec } = scripted({});
        await bridgeRepo(exec, ALIAS, LOCAL, "proj", () => undefined);
        expect(calls).toEqual([]);
    });

    it("bootstraps a repo born in the sandbox: init, remote, fetch, then a mixed reset to the sandbox tip", async () => {
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
        await bridgeRepo(exec, ALIAS, LOCAL, "proj", () => undefined);
        expect(calls).toContain("git init -q");
        expect(calls).toContain(`git remote add sandbox ${ALIAS}:/history/gits/proj`);
        expect(calls).toContain("git fetch -q sandbox +refs/heads/main:refs/remotes/sandbox/main");
        expect(calls).toContain(`git reset -q ${TIP}`);
    });

    it("makes the local repo ignore the exec bit, the way every git command in the sandbox does", async () => {
        const { calls, exec } = scripted({ "git remote get-url": undefined, "git ls-remote": undefined }, [DIR, join(DIR, ".git")]);
        await bridgeRepo(exec, ALIAS, LOCAL, "proj", () => undefined);
        expect(calls).toContain("git config core.fileMode false");
    });

    it("leaves a config that already reads modes the sandbox's way alone", async () => {
        const { calls, exec } = scripted({ "git config --get core.fileMode": "false\n", "git ls-remote": undefined }, [DIR, join(DIR, ".git")]);
        await bridgeRepo(exec, ALIAS, LOCAL, "proj", () => undefined);
        expect(calls).not.toContain("git config core.fileMode false");
    });

    it("URI-encodes a nested repo id in the remote url", async () => {
        const { calls, exec } = scripted({ "git remote get-url": undefined, "git ls-remote": undefined }, [
            join(LOCAL, "references", "eve"),
            join(LOCAL, "references", "eve", ".git"),
        ]);
        await bridgeRepo(exec, ALIAS, LOCAL, "references/eve", () => undefined);
        expect(calls).toContain(`git remote add sandbox ${ALIAS}:/history/gits/references%2Feve`);
    });

    it("fast-forwards when local HEAD is an ancestor of the sandbox tip", async () => {
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
        await bridgeRepo(exec, ALIAS, LOCAL, "proj", () => undefined);
        expect(calls).toContain(`git merge-base --is-ancestor HEAD ${TIP}`);
        expect(calls).toContain(`git reset -q ${TIP}`);
    });

    it("stops at the probe when the sandbox tip hasn't moved, without fetching", async () => {
        const { calls, exec } = scripted(
            {
                "git remote get-url": `${ALIAS}:/history/gits/proj\n`,
                "git ls-remote": SYMREF_MAIN,
                "git rev-parse -q --verify HEAD": `${TIP}\n`,
                "git symbolic-ref --short -q HEAD": "main\n",
            },
            [DIR, join(DIR, ".git")],
        );
        await bridgeRepo(exec, ALIAS, LOCAL, "proj", () => undefined);
        expect(calls.some((line) => line.startsWith("git fetch"))).toBe(false);
        expect(calls.some((line) => line.startsWith("git reset"))).toBe(false);
        // The whole quiet pass is this one round trip, which is what makes running it every tick affordable.
        expect(calls.filter((line) => line.startsWith("git ls-remote"))).toHaveLength(1);
    });

    it("still follows the sandbox's branch when HEAD already sits on its tip under another name", async () => {
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
        await bridgeRepo(exec, ALIAS, LOCAL, "proj", () => undefined);
        expect(calls).toContain("git symbolic-ref HEAD refs/heads/feature");
        expect(calls).toContain(`git reset -q ${TIP2}`);
    });

    it("never resets over local staged work", async () => {
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
        await bridgeRepo(exec, ALIAS, LOCAL, "proj", () => undefined);
        expect(calls.some((line) => line.startsWith("git reset"))).toBe(false);
    });

    it("never resets local commits the sandbox lacks", async () => {
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
        await bridgeRepo(exec, ALIAS, LOCAL, "proj", (message) => logs.push(message));
        expect(calls.some((line) => line.startsWith("git reset"))).toBe(false);
        expect(logs.join("\n")).toContain("diverge");
    });

    // The rewind: the sandbox undoes a commit the bridge had already installed here. HEAD is then a commit the
    // sandbox lacks: indistinguishable from local work by ancestry alone, and refusing it strands the desktop
    // on discarded history while file sync keeps delivering every later commit as uncommitted noise.
    it("follows the sandbox back when it rewinds history the bridge itself installed", async () => {
        const logs: string[] = [];
        const { calls, exec } = scripted(
            {
                "git remote get-url": `${ALIAS}:/history/gits/proj\n`,
                "git ls-remote": SYMREF_MAIN,
                "git rev-parse -q --verify refs/remotes/sandbox/main": `${TIP}\n`, // where the sandbox rewound to
                "git rev-parse -q --verify refs/intentic/bridged/main": `${DIVERGED}\n`, // the bridge put local HEAD here
                "git rev-parse -q --verify HEAD": `${DIVERGED}\n`,
                "git symbolic-ref --short -q HEAD": "main\n",
                [`git merge-base --is-ancestor HEAD ${TIP}`]: undefined, // not a fast-forward
            },
            [DIR, join(DIR, ".git")],
        );
        await bridgeRepo(exec, ALIAS, LOCAL, "proj", (message) => logs.push(message));
        expect(calls).toContain(`git reset -q ${TIP}`);
        expect(calls).toContain(`git update-ref refs/intentic/bridged/main ${TIP}`);
        expect(logs.join("\n")).toContain("rewound");
    });

    // The same shape, but the local tip is NOT what the bridge installed: someone committed here. That is work
    // no sync may destroy, so the refusal stands.
    it("still refuses when the local tip is a commit the bridge never installed", async () => {
        const logs: string[] = [];
        const { calls, exec } = scripted(
            {
                "git remote get-url": `${ALIAS}:/history/gits/proj\n`,
                "git ls-remote": SYMREF_MAIN,
                "git rev-parse -q --verify refs/remotes/sandbox/main": `${TIP}\n`,
                "git rev-parse -q --verify refs/intentic/bridged/main": `${OLD}\n`,
                "git rev-parse -q --verify HEAD": `${DIVERGED}\n`,
                "git symbolic-ref --short -q HEAD": "main\n",
                [`git merge-base --is-ancestor HEAD ${TIP}`]: undefined,
            },
            [DIR, join(DIR, ".git")],
        );
        await bridgeRepo(exec, ALIAS, LOCAL, "proj", (message) => logs.push(message));
        expect(calls.some((line) => line.startsWith("git reset"))).toBe(false);
        expect(logs.join("\n")).toContain("diverge");
    });

    /* The regression the marker exists for. The valve used to ask the REMOTE-TRACKING ref what the bridge had
     * installed, and a fetch advances that ref whether or not HEAD follows, so the answer survived exactly one
     * pass. Miss the rewind once (an agent too old to follow it, one tick with the sandbox unreachable, anything
     * staged at the wrong moment) and the repo froze for good: hundreds of "changes" that grew with every later
     * sandbox commit and that nothing but a hand-run reset could clear. Here the sandbox has committed many times
     * since the bridge last moved HEAD, and it still recognises its own history. */
    it("still recognises its own history long after passes that fetched without moving HEAD", async () => {
        const logs: string[] = [];
        const { calls, exec } = scripted(
            {
                "git remote get-url": `${ALIAS}:/history/gits/proj\n`,
                "git ls-remote": SYMREF_MAIN,
                // Far past what the bridge installed: this ref has followed the sandbox through every pass since.
                "git rev-parse -q --verify refs/remotes/sandbox/main": `${TIP}\n`,
                "git rev-parse -q --verify refs/intentic/bridged/main": `${DIVERGED}\n`,
                "git rev-parse -q --verify HEAD": `${DIVERGED}\n`,
                "git symbolic-ref --short -q HEAD": "main\n",
                [`git merge-base --is-ancestor HEAD ${TIP}`]: undefined,
            },
            [DIR, join(DIR, ".git")],
        );
        await bridgeRepo(exec, ALIAS, LOCAL, "proj", (message) => logs.push(message));
        expect(calls).toContain(`git reset -q ${TIP}`);
        // And the decision owes nothing to the remote-tracking ref's value BEFORE the fetch: it is never read there.
        const fetchAt = calls.findIndex((line) => line.startsWith("git fetch"));
        expect(calls.slice(0, fetchAt).some((line) => line.includes("refs/remotes/sandbox/main"))).toBe(false);
        expect(logs.join("\n")).toContain("rewound");
    });

    // Arming the valve costs no divergence: a repo that has never once fallen behind never reaches the reset
    // that records a marker, so the quiet pass records one itself. This is also the state a hand-run recovery
    // leaves behind, and it must not have to freeze a second time before the valve can help.
    it("records what HEAD holds on a quiet pass, so an install that never falls behind still carries a marker", async () => {
        const { calls, exec } = scripted(
            {
                "git remote get-url": `${ALIAS}:/history/gits/proj\n`,
                "git ls-remote": SYMREF_MAIN,
                "git rev-parse -q --verify refs/intentic/bridged/main": undefined, // never recorded
                "git rev-parse -q --verify HEAD": `${TIP}\n`, // already level with the sandbox
                "git symbolic-ref --short -q HEAD": "main\n",
            },
            [DIR, join(DIR, ".git")],
        );
        await bridgeRepo(exec, ALIAS, LOCAL, "proj", () => undefined);
        expect(calls).toContain(`git update-ref refs/intentic/bridged/main ${TIP}`);
        expect(calls.some((line) => line.startsWith("git fetch"))).toBe(false);
    });

    it("leaves an already-current marker alone rather than rewriting it every tick", async () => {
        const { calls, exec } = scripted(
            {
                "git remote get-url": `${ALIAS}:/history/gits/proj\n`,
                "git ls-remote": SYMREF_MAIN,
                "git rev-parse -q --verify refs/intentic/bridged/main": `${TIP}\n`,
                "git rev-parse -q --verify HEAD": `${TIP}\n`,
                "git symbolic-ref --short -q HEAD": "main\n",
            },
            [DIR, join(DIR, ".git")],
        );
        await bridgeRepo(exec, ALIAS, LOCAL, "proj", () => undefined);
        expect(calls.some((line) => line.startsWith("git update-ref"))).toBe(false);
    });
});

describe("runGitBridge", () => {
    const config: Pairing = { sandboxUrl: "https://s.example.dev", sandboxId: "x", mode: "sync", localDir: LOCAL };
    // A mirror-only enrollment has no localDir AT ALL: the key is absent, not present-and-undefined, which
    // is the distinction the config type draws and the bridge reads.
    const { localDir: _localDir, ...withoutLocalDir } = config;

    it("reuses a repo list an earlier pass returned instead of re-listing over ssh", async () => {
        const { calls, exec } = scripted({});
        expect(await runGitBridge(exec, config, () => undefined, ["proj"])).toEqual(["proj"]);
        expect(calls.some((line) => line.startsWith("ssh"))).toBe(false);
    });

    it("lists over ssh when handed none, and hands the list back for the next pass", async () => {
        const { calls, exec } = scripted({ ssh: "intentic\nroot\n" });
        expect(await runGitBridge(exec, config, () => undefined, undefined)).toEqual(["intentic"]);
        expect(calls.some((line) => line.startsWith("ssh"))).toBe(true);
    });

    it("returns undefined when the sandbox is unreachable, so the next pass lists again", async () => {
        const { exec } = scripted({ ssh: undefined });
        expect(await runGitBridge(exec, config, () => undefined, undefined)).toBeUndefined();
    });

    it("does nothing for a mirror-only enrollment, which has no local tree to bridge into", async () => {
        const { calls, exec } = scripted({ ssh: "intentic\n" });
        expect(await runGitBridge(exec, { ...withoutLocalDir, mode: "mirror" as const }, () => undefined, undefined)).toBeUndefined();
        expect(calls).toEqual([]);
    });
});
