import { WORKSPACE_ROOT } from "@intentic/constants";
import { join } from "node:path";
import type { BridgeHold, Pairing } from "../config.js";
import {
    type BridgeExec,
    type BridgeMemory,
    bridgeRepo,
    type FetchResult,
    failureReason,
    listSandboxRepos,
    nextHold,
    type PackFs,
    type PackTemp,
    runGitBridge,
    STALE_TEMP_MS,
    strandedTemps,
} from "../git-bridge.js";

// Maps a command-line prefix to its stdout (undefined = failure); first match wins, unscripted succeeds empty.
// `existing` is the fake filesystem; an array answers successive calls in order (last entry repeats). A fetch is
// scripted the same way (undefined = git refused it), unless `fetches` says how each one ended, in order.
const scripted = (
    handlers: Record<string, string | undefined | readonly (string | undefined)[]>,
    existing: readonly string[] = [],
    fetches: readonly FetchResult[] = [],
) => {
    const calls: string[] = [];
    const paths = new Set(existing);
    const seen = new Map<string, number>();
    const answer = async (line: string): Promise<string | undefined> => {
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
    };
    let fetched = 0;
    const exec: BridgeExec = {
        run: async (command, args) => await answer([command, ...args].join(" ")),
        fetch: async (args) => {
            const out = await answer(["git", ...args].join(" "));
            const told = fetches[Math.min(fetched, fetches.length - 1)];
            fetched += 1;
            return told ?? { outcome: out === undefined ? "failed" : "fetched", stderr: "" };
        },
        exists: (path) => paths.has(path),
    };
    return { calls, exec };
};

// Holds kept in a map, as the pairing's record keeps them.
const remembered = (start: readonly BridgeHold[] = []) => {
    const holds = new Map(start.map((hold) => [hold.repo, hold]));
    const memory: BridgeMemory = {
        held: (repo) => holds.get(repo),
        record: async (repo, hold) => {
            if (hold === undefined) {
                holds.delete(repo);
            } else {
                holds.set(repo, hold);
            }
            await Promise.resolve();
        },
    };
    return { holds, memory };
};

// A pack folder whose listing is scripted per call (last repeats), recording what was removed.
const packFolder = (listings: readonly (readonly PackTemp[])[]) => {
    const removed: string[] = [];
    let read = 0;
    const packs: PackFs = {
        temps: async () => {
            const listing = listings[Math.min(read, listings.length - 1)] ?? [];
            read += 1;
            return await Promise.resolve(listing);
        },
        remove: async (path) => {
            removed.push(path);
            return await Promise.resolve(true);
        },
        settle: async () => await Promise.resolve(),
    };
    return { packs, removed };
};

const ALIAS = "intentic-sync-x";
const LOCAL = join("/", "home", "u", "sandbox");
const DIR = join(LOCAL, "proj");

// Stand-in object ids, hex-shaped like real `ls-remote` output.
const TIP = "a1a1a1"; // where the sandbox's main sits
const OLD = "b2b2b2"; // a local HEAD the sandbox has moved past
const DIVERGED = "c3c3c3"; // a local HEAD carrying commits the sandbox lacks
const TIP2 = "d4d4d4"; // where the sandbox's feature branch sits

// What `ls-remote --symref sandbox HEAD` answers: symref line, then tip line, both from one round trip.
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
        // Born here, so it may take the sandbox's shallow boundary as its own.
        expect(calls).toContain("git fetch --progress --update-shallow sandbox +refs/heads/main:refs/remotes/sandbox/main");
        expect(calls).toContain(`git reset -q ${TIP}`);
    });

    it("makes the local repo ignore the exec bit, the way every git command in the sandbox does", async () => {
        const { calls, exec } = scripted({ "git remote get-url": undefined, "git ls-remote": undefined }, [DIR, join(DIR, ".git")]);
        await bridgeRepo(exec, ALIAS, LOCAL, "proj", () => undefined);
        expect(calls).toContain("git config core.fileMode false");
    });

    it("leaves a config that already reads modes the sandbox's way alone", async () => {
        const { calls, exec } = scripted({ "git config --local --get core.fileMode": "false\n", "git ls-remote": undefined }, [DIR, join(DIR, ".git")]);
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
        // The quiet pass makes exactly one ls-remote call.
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

    // The sandbox rewinds a commit the bridge already installed; HEAD then holds a commit the sandbox lacks,
    // indistinguishable from local work by ancestry alone.
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

    // Same shape, but local HEAD is not what the bridge installed; that's local work, so refusal stands.
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

    // Detection relies on refs/intentic/bridged/main, never the remote-tracking ref: a fetch advances that
    // regardless of whether HEAD follows.
    it("still recognises its own history long after passes that fetched without moving HEAD", async () => {
        const logs: string[] = [];
        const { calls, exec } = scripted(
            {
                "git remote get-url": `${ALIAS}:/history/gits/proj\n`,
                "git ls-remote": SYMREF_MAIN,
                // Far past what the bridge installed; has followed the sandbox through every pass since.
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
        // Confirms the decision never reads the remote-tracking ref's value before the fetch.
        const fetchAt = calls.findIndex((line) => line.startsWith("git fetch"));
        expect(calls.slice(0, fetchAt).some((line) => line.includes("refs/remotes/sandbox/main"))).toBe(false);
        expect(logs.join("\n")).toContain("rewound");
    });

    // A repo that never falls behind never hits the reset that records the marker; the quiet pass records one
    // itself so recovery doesn't need a second freeze.
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
    // A mirror-only enrollment has no localDir key at all (absent, not present-and-undefined).
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

    // The owner's own repository: its `.git` is theirs, and the sandbox's history of the folder is a separate repo the
    // bridge would init, re-point and reset theirs onto. Not even listed, so a sandbox repo named like a subfolder of the
    // project can never be bridged into it.
    it("does nothing for a project pairing, not even list the sandbox's repos", async () => {
        const { calls, exec } = scripted({ ssh: "intentic\nmy-app\n" });
        const project: Pairing = { ...config, remoteDir: `${WORKSPACE_ROOT}/my-app`, project: true };
        expect(await runGitBridge(exec, project, () => undefined, undefined)).toBeUndefined();
        expect(await runGitBridge(exec, project, () => undefined, ["my-app"])).toBeUndefined();
        expect(calls).toEqual([]);
    });

    it("does nothing for a mirror-only enrollment, which has no local tree to bridge into", async () => {
        const { calls, exec } = scripted({ ssh: "intentic\n" });
        expect(await runGitBridge(exec, { ...withoutLocalDir, mode: "mirror" as const }, () => undefined, undefined)).toBeUndefined();
        expect(calls).toEqual([]);
    });
});

describe("nextHold", () => {
    const NOW = 1_000_000;
    const MINUTE = 60_000;

    it("waits ten minutes after a first stall and twice as long after each later one, up to half a day", () => {
        const first = nextHold("proj", undefined, "stalled", NOW);
        expect(first).toEqual({ repo: "proj", reason: "stalled", failures: 1, since: NOW, retryAt: NOW + 10 * MINUTE });
        const second = nextHold("proj", first, "stalled", NOW + 1);
        expect(second.retryAt - (NOW + 1)).toBe(20 * MINUTE);
        expect(second.since).toBe(NOW);
        let hold = second;
        for (let tries = 0; tries < 30; tries += 1) {
            hold = nextHold("proj", hold, "stalled", NOW);
        }
        expect(hold.retryAt - NOW).toBe(12 * 60 * MINUTE);
    });

    it("starts a fetch that ran out of time at half a day, and a shallow refusal at a day capped at a week", () => {
        expect(nextHold("proj", undefined, "too-long", NOW).retryAt - NOW).toBe(12 * 60 * MINUTE);
        expect(nextHold("proj", undefined, "shallow", NOW).retryAt - NOW).toBe(24 * 60 * MINUTE);
        let hold = nextHold("proj", undefined, "shallow", NOW);
        for (let tries = 0; tries < 10; tries += 1) {
            hold = nextHold("proj", hold, "shallow", NOW);
        }
        expect(hold.retryAt - NOW).toBe(7 * 24 * 60 * MINUTE);
    });

    it("reads git's shallow refusal as its own reason and anything else as a plain failure", () => {
        expect(failureReason(" ! [rejected] main -> sandbox/main (shallow roots are not allowed to be updated)")).toBe("shallow");
        expect(failureReason("fatal: Could not read from remote repository.")).toBe("failed");
    });
});

describe("strandedTemps", () => {
    const NOW = 10 * STALE_TEMP_MS;
    const temp = (name: string, size: number, age: number): PackTemp => ({ name, size, modifiedAt: NOW - age });

    it("takes what appeared during the fetch and what is stale, but never a file still growing or already gone", () => {
        const first = [temp("tmp_pack_new", 100, 0), temp("tmp_pack_growing", 5, 0), temp("tmp_pack_recent", 7, 60_000), temp("tmp_pack_stale", 9, STALE_TEMP_MS), temp("tmp_idx_gone", 1, 0)];
        const second = [temp("tmp_pack_new", 100, 0), temp("tmp_pack_growing", 50, 0), temp("tmp_pack_recent", 7, 60_000), temp("tmp_pack_stale", 9, STALE_TEMP_MS)];
        const before = new Set(["tmp_pack_recent", "tmp_pack_stale"]);
        expect(strandedTemps(first, second, before, NOW).map((entry) => entry.name)).toEqual(["tmp_pack_new", "tmp_pack_stale"]);
    });
});

describe("bridgeRepo holds", () => {
    const NOW = 50 * STALE_TEMP_MS;
    const MINUTE = 60_000;
    // A clone with history of its own, one commit behind the sandbox, so a pass has to fetch.
    const behind = (repo: string, extra: Record<string, string | undefined> = {}) => ({
        handlers: {
            "git remote get-url": `${ALIAS}:/history/gits/${repo}\n`,
            "git ls-remote": SYMREF_MAIN,
            "git rev-parse -q --verify refs/remotes/sandbox/main": `${TIP}\n`,
            "git rev-parse -q --verify HEAD": `${OLD}\n`,
            "git symbolic-ref --short -q HEAD": "main\n",
            "git rev-parse --git-path": ".git/objects/pack\n",
            "git rev-parse --is-shallow-repository": "false\n",
            ...extra,
        },
        existing: [join(LOCAL, repo), join(LOCAL, repo, ".git")],
    });
    const old = { name: "tmp_pack_old", size: 5, modifiedAt: NOW - 10 * MINUTE };
    const left = { name: "tmp_pack_left", size: 3 * 1024 ** 3, modifiedAt: NOW };

    it("holds a repo whose fetch stalled, removes only the pack that fetch left, and never makes a full clone shallow", async () => {
        const { handlers, existing } = behind("stall");
        const { calls, exec } = scripted(handlers, existing, [{ outcome: "stalled", stderr: "" }]);
        const { holds, memory } = remembered();
        // Listings: the hourly sweep (two reads), before the fetch, then the two reads after it.
        const { packs, removed } = packFolder([[old], [old], [old], [old, left], [old, left]]);
        const said: string[] = [];
        await bridgeRepo(exec, ALIAS, LOCAL, "stall", (line) => said.push(line), { memory, packs, now: () => NOW });
        expect(calls).toContain("git fetch --progress sandbox +refs/heads/main:refs/remotes/sandbox/main");
        expect(removed).toEqual([join(LOCAL, "stall", ".git", "objects", "pack", "tmp_pack_left")]);
        expect(holds.get("stall")).toEqual({ repo: "stall", reason: "stalled", failures: 1, since: NOW, retryAt: NOW + 10 * MINUTE });
        expect(said.join("\n")).toContain("removed the 3.0 GB it had received so far; trying again in 10 minutes");
        expect(calls.some((line) => line.startsWith("git reset"))).toBe(false);
    });

    it("leaves a held repo alone until its wait is over, then fetches and forgets the hold", async () => {
        const { handlers, existing } = behind("held");
        const hold: BridgeHold = { repo: "held", reason: "stalled", failures: 2, since: NOW - MINUTE, retryAt: NOW + MINUTE };
        const { holds, memory } = remembered([hold]);
        const { packs } = packFolder([[]]);
        const early = scripted(handlers, existing);
        await bridgeRepo(early.exec, ALIAS, LOCAL, "held", () => undefined, { memory, packs, now: () => NOW });
        expect(early.calls.some((line) => line.startsWith("git fetch"))).toBe(false);
        expect(holds.get("held")).toEqual(hold);
        const later = scripted(handlers, existing);
        const said: string[] = [];
        await bridgeRepo(later.exec, ALIAS, LOCAL, "held", (line) => said.push(line), { memory, packs, now: () => NOW + 2 * MINUTE });
        expect(later.calls.some((line) => line.startsWith("git fetch"))).toBe(true);
        expect(later.calls).toContain(`git reset -q ${TIP}`);
        expect(holds.has("held")).toBe(false);
        expect(said.join("\n")).toContain("after 2 tries that did not finish");
    });

    it("says so when a shallow sandbox copy is refused by a clone with a full history of its own", async () => {
        const { handlers, existing } = behind("shallow");
        const stderr = " ! [rejected]        main       -> sandbox/main  (shallow roots are not allowed to be updated)";
        const { exec } = scripted(handlers, existing, [{ outcome: "failed", stderr }]);
        const { holds, memory } = remembered();
        await bridgeRepo(exec, ALIAS, LOCAL, "shallow", () => undefined, { memory, packs: packFolder([[]]).packs, now: () => NOW });
        expect(holds.get("shallow")?.reason).toBe("shallow");
        expect(holds.get("shallow")?.retryAt).toBe(NOW + 24 * 60 * MINUTE);
    });

    it("asks the sandbox first, and fetches nothing while its copy is shallow and this clone's history is full", async () => {
        const { handlers, existing } = behind("probed", { ssh: "true\n" });
        const { calls, exec } = scripted(handlers, existing);
        const { holds, memory } = remembered();
        const said: string[] = [];
        await bridgeRepo(exec, ALIAS, LOCAL, "probed", (line) => said.push(line), { memory, packs: packFolder([[]]).packs, now: () => NOW });
        expect(calls).toContain(`ssh -o BatchMode=yes ${ALIAS} git --git-dir=/history/gits/probed rev-parse --is-shallow-repository`);
        expect(calls.some((line) => line.startsWith("git fetch"))).toBe(false);
        expect(holds.get("probed")).toMatchObject({ reason: "shallow", failures: 1, retryAt: NOW + 24 * 60 * MINUTE });
        expect(said.join("\n")).toContain("not fetched from the sandbox");
        // Once its wait is over it asks again, still without fetching, and waits twice as long.
        await bridgeRepo(exec, ALIAS, LOCAL, "probed", () => undefined, { memory, packs: packFolder([[]]).packs, now: () => NOW + 25 * 60 * MINUTE });
        expect(calls.some((line) => line.startsWith("git fetch"))).toBe(false);
        expect(holds.get("probed")).toMatchObject({ failures: 2, retryAt: NOW + 25 * 60 * MINUTE + 48 * 60 * MINUTE });
    });

    it("fetches once the sandbox says its copy is whole", async () => {
        const { handlers, existing } = behind("whole", { ssh: "false\n" });
        const { calls, exec } = scripted(handlers, existing);
        await bridgeRepo(exec, ALIAS, LOCAL, "whole", () => undefined, { memory: remembered().memory, packs: packFolder([[]]).packs, now: () => NOW });
        expect(calls).toContain("git fetch --progress sandbox +refs/heads/main:refs/remotes/sandbox/main");
        expect(calls).toContain(`git reset -q ${TIP}`);
    });

    it("never asks the sandbox when the clone may take a shallow boundary anyway", async () => {
        const { handlers, existing } = behind("thin2", { "git rev-parse --is-shallow-repository": "true\n" });
        const { calls, exec } = scripted(handlers, existing);
        await bridgeRepo(exec, ALIAS, LOCAL, "thin2", () => undefined, { memory: remembered().memory, packs: packFolder([[]]).packs, now: () => NOW });
        expect(calls.some((line) => line.startsWith("ssh"))).toBe(false);
    });

    it("lets an already-shallow clone take the sandbox's shallow boundary", async () => {
        const { handlers, existing } = behind("thin", { "git rev-parse --is-shallow-repository": "true\n" });
        const { calls, exec } = scripted(handlers, existing);
        await bridgeRepo(exec, ALIAS, LOCAL, "thin", () => undefined, { memory: remembered().memory, packs: packFolder([[]]).packs, now: () => NOW });
        expect(calls).toContain("git fetch --progress --update-shallow sandbox +refs/heads/main:refs/remotes/sandbox/main");
    });

    it("holds nothing for a fetch this agent stopped itself", async () => {
        const { handlers, existing } = behind("stopped");
        const { exec } = scripted(handlers, existing, [{ outcome: "stopped", stderr: "" }]);
        const { holds, memory } = remembered();
        await bridgeRepo(exec, ALIAS, LOCAL, "stopped", () => undefined, { memory, packs: packFolder([[]]).packs, now: () => NOW });
        expect(holds.size).toBe(0);
    });

    it("forgets a hold once the clone is level with the sandbox (the owner fetched by hand)", async () => {
        const { handlers, existing } = behind("level", { "git rev-parse -q --verify HEAD": `${TIP}\n` });
        const { holds, memory } = remembered([{ repo: "level", reason: "too-long", failures: 1, since: NOW, retryAt: NOW + 60 * MINUTE }]);
        await bridgeRepo(scripted(handlers, existing).exec, ALIAS, LOCAL, "level", () => undefined, { memory, now: () => NOW });
        expect(holds.size).toBe(0);
    });

    it("clears an earlier agent's stale leftovers before its first fetch there, and not again within the hour", async () => {
        const { handlers, existing } = behind("leftovers");
        const stale = { name: "tmp_pack_ancient", size: 2 * 1024 ** 3, modifiedAt: NOW - 2 * STALE_TEMP_MS };
        const { packs, removed } = packFolder([[stale, old], [stale, old], [stale, old], [old]]);
        const said: string[] = [];
        const options = { memory: remembered().memory, packs, now: () => NOW };
        await bridgeRepo(scripted(handlers, existing).exec, ALIAS, LOCAL, "leftovers", (line) => said.push(line), options);
        expect(removed).toEqual([join(LOCAL, "leftovers", ".git", "objects", "pack", "tmp_pack_ancient")]);
        expect(said.join("\n")).toContain("removed 2.0 GB of half-received git packs an earlier fetch left behind");
        await bridgeRepo(scripted(handlers, existing).exec, ALIAS, LOCAL, "leftovers", () => undefined, options);
        expect(removed).toHaveLength(1);
    });

    it("sweeps a quiet repo again an hour later, so a fetch its own restart cut off minutes ago still goes", async () => {
        const { handlers, existing } = behind("cutoff", { "git rev-parse -q --verify HEAD": `${TIP}\n` });
        const cut = { name: "tmp_pack_cut", size: 1024 ** 3, modifiedAt: NOW - 10 * MINUTE };
        const { packs, removed } = packFolder([[cut]]);
        const pass = async (at: number): Promise<void> =>
            await bridgeRepo(scripted(handlers, existing).exec, ALIAS, LOCAL, "cutoff", () => undefined, { memory: remembered().memory, packs, now: () => at });
        await pass(NOW);
        expect(removed).toEqual([]);
        await pass(NOW + STALE_TEMP_MS);
        expect(removed).toEqual([join(LOCAL, "cutoff", ".git", "objects", "pack", "tmp_pack_cut")]);
        await pass(NOW + STALE_TEMP_MS + MINUTE);
        expect(removed).toHaveLength(1);
    });
});
