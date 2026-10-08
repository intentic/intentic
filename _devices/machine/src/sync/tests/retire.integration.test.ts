import { mkdtempSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKSPACE_ROOT } from "@intentic/constants";
import type { BridgeExec, UnbridgeFs } from "../git-bridge.js";

// (2026-10-05) What a gone sandbox leaves on this machine, and the one rule for taking it away: everything this agent made
// for it goes, the owner's folder and restore points stay. On a throwaway home, since config.ts fixes its paths at import
// time; Mutagen is a shell script that records what it was asked to terminate, and git is a seam.
process.env["HOME"] = mkdtempSync(join(tmpdir(), "retire-"));
process.env["USERPROFILE"] = process.env["HOME"];
const home = process.env["HOME"];
const { agentHome } = await import("@intentic/local-agent");
const { readState, upsertPairing } = await import("../config.js");
const { retireSandbox, sandboxesNamed } = await import("../retire.js");
const { checkContainers, checkKeptHere, sandboxAnswered, sandboxSaidGone } = await import("../gone-watch.js");
const { distroAnswer, forgetSandbox, forgotInWords } = await import("../forget-command.js");
const { listingRecordPath } = await import("../project/project-local.js");
const { restoreDir } = await import("../restore-points.js");
const { bridgedRepoCandidates, unbridgeRepos } = await import("../git-bridge.js");
const { knownHostsPath, sshConfigPath } = await import("../config.js");
const { pairingSshConfig, sshAlias, writeManagedSshConfig } = await import("../ssh.js");
const { syncSshPort } = await import("../tunnel.js");

const machineDir = agentHome("machine").dir;
const GONE = "sandbox-2e8d89d75865-intentic-dev";
const GONE_URL = "https://sandbox-2e8d89d75865.intentic.dev";
const KEPT = "sandbox-0738cd6b5027-intentic-dev";
const KEPT_URL = "https://sandbox-0738cd6b5027.intentic.dev";
const workspace = join(home, "intentic", "2e8d89d75865");

// A Mutagen that answers listings from a fixed script and writes every terminate it is asked for to a file.
const fakeMutagen = async (
    listing: { readonly sync?: string; readonly forward?: string; readonly fails?: boolean } = {},
): Promise<{ path: string; terminated: () => Promise<string[]> }> => {
    const dir = mkdtempSync(join(tmpdir(), "fake-mutagen-"));
    const record = join(dir, "terminated.txt");
    const path = join(dir, "mutagen");
    await writeFile(
        path,
        `#!/bin/sh
if [ "$2" = "list" ]; then
  ${
      listing.fails === true
          ? 'echo "client/daemon version mismatch" >&2; exit 1'
          : `if [ "$4" = "{{json .}}" ]; then echo '${JSON.stringify(
                (listing.sync ?? "")
                    .split(" ")
                    .filter((name) => name !== "")
                    .map((name) => ({ name, paused: false, alpha: {}, beta: {}, ignore: {} })),
            )}'; elif [ "$1" = "sync" ]; then echo "${listing.sync ?? ""}"; else echo "${listing.forward ?? ""}"; fi; exit 0`
  }
fi
if [ "$2" = "terminate" ]; then shift 2; echo "$@" >> ${record}; exit 0; fi
if [ "$2" = "pause" ] || [ "$2" = "resume" ]; then shift 2; echo "$@" >> ${record}.paused; exit 0; fi
exit 0
`,
        { mode: 0o755 },
    );
    return { path, terminated: async () => (await readFile(record, "utf8").catch(() => "")).split("\n").filter((line) => line !== "") };
};

const exists = async (path: string): Promise<boolean> =>
    await stat(path).then(
        () => true,
        () => false,
    );

beforeEach(async () => {
    await mkdir(machineDir, { recursive: true });
    await writeFile(join(machineDir, "sync.json"), JSON.stringify({ pairings: [] }));
    await upsertPairing({
        sandboxUrl: GONE_URL,
        sandboxId: GONE,
        mode: "sync",
        syncToken: "ist_gone",
        localDir: workspace,
        mirroredPorts: [{ port: 5173, host: "127.0.0.1" }],
    });
    await upsertPairing({
        sandboxUrl: KEPT_URL,
        sandboxId: KEPT,
        mode: "sync",
        syncToken: "ist_kept",
        localDir: join(home, "intentic", "0738cd6b5027"),
    });
});

describe("sandboxesNamed", () => {
    it("names a sandbox by its id, the slug ic knows it by, or its container, and never by a part of one", async () => {
        const { pairings } = await readState();
        expect(sandboxesNamed(pairings, GONE)).toEqual([GONE]);
        expect(sandboxesNamed(pairings, "sandbox-2e8d89d75865")).toEqual([GONE]);
        expect(sandboxesNamed(pairings, "2e8d89d75865")).toEqual([GONE]);
        expect(
            sandboxesNamed(
                [
                    {
                        ...pairings[0],
                        sandboxUrl: GONE_URL,
                        sandboxId: "x",
                        transport: "docker",
                        container: "intentic-sandbox-my-blog",
                        project: true,
                        remoteDir: `${WORKSPACE_ROOT}/blog`,
                    } as never,
                ],
                "my-blog",
            ),
        ).toEqual(["x"]);
        expect(sandboxesNamed(pairings, "2e8d")).toEqual([]);
        expect(sandboxesNamed(pairings, "")).toEqual([]);
    });
});

describe("retireSandbox", () => {
    it("removes the pairing, its sessions, forwards, ssh block, host key, hash cache and bridge remote, and keeps its folder and restore points", async () => {
        await mkdir(workspace, { recursive: true });
        await writeFile(join(workspace, "notes.md"), "the owner's own");
        await mkdir(join(restoreDir(machineDir, GONE), "20261001T000000.000Z"), { recursive: true });
        await mkdir(join(machineDir, "hashes"), { recursive: true });
        await writeFile(listingRecordPath(machineDir, GONE), "{}");
        await writeManagedSshConfig(pairingSshConfig((await readState()).pairings));
        await writeFile(
            knownHostsPath,
            `${sshAlias(GONE)} ssh-ed25519 AAAAgone\n[${sshAlias(GONE)}]:${syncSshPort(GONE)} ssh-ed25519 AAAAgone\n${sshAlias(KEPT)} ssh-ed25519 AAAAkept\n`,
        );
        const mutagen = await fakeMutagen({
            sync: `intentic-${GONE} intentic-${GONE}-state intentic-${KEPT}`,
            forward: `intentic-fwd-${GONE}-5173 intentic-fwd-${KEPT}-3000`,
        });
        const unbridged: string[] = [];
        const said: string[] = [];

        const retired = await retireSandbox(GONE, (line) => said.push(line), "gone since 2026-09-28", {
            mutagen: mutagen.path,
            unbridge: async (alias, localDir) => {
                unbridged.push(`${alias} ${localDir}`);
                return 1;
            },
        });

        expect(retired).toEqual({ sandboxId: GONE, pairings: [GONE], folders: [workspace] });
        expect((await readState()).pairings.map((pairing) => pairing.sandboxId)).toEqual([KEPT]);
        expect(await mutagen.terminated()).toEqual([`intentic-${GONE} intentic-${GONE}-state`, `intentic-fwd-${GONE}-5173`]);
        expect(await readFile(sshConfigPath, "utf8")).not.toContain(sshAlias(GONE));
        expect(await readFile(sshConfigPath, "utf8")).toContain(sshAlias(KEPT));
        expect(await readFile(knownHostsPath, "utf8")).toBe(`${sshAlias(KEPT)} ssh-ed25519 AAAAkept\n`);
        expect(await exists(listingRecordPath(machineDir, GONE))).toBe(false);
        expect(unbridged).toEqual([`${sshAlias(GONE)} ${workspace}`]);
        // The owner's: kept, and said so.
        expect(await readFile(join(workspace, "notes.md"), "utf8")).toBe("the owner's own");
        expect(await exists(join(restoreDir(machineDir, GONE), "20261001T000000.000Z"))).toBe(true);
        expect(said.join("\n")).toContain(`${workspace} and its restore points are kept`);
    });

    it("ends each session on its own when Mutagen does not answer the listing, rather than leaving them all running", async () => {
        const mutagen = await fakeMutagen({ fails: true });
        await retireSandbox(GONE, () => undefined, "forgotten", { mutagen: mutagen.path, unbridge: async () => 0 });
        expect(await mutagen.terminated()).toEqual([`intentic-${GONE}`, `intentic-${GONE}-state`, `intentic-fwd-${GONE}-5173`]);
    });

    it("has nothing to do for a sandbox this machine does not pair", async () => {
        expect(await retireSandbox("sandbox-never", () => undefined, "forgotten", { mutagen: undefined })).toBeUndefined();
        expect((await readState()).pairings).toHaveLength(2);
    });
});

describe("sync forget", () => {
    it("retires the named sandbox here and says what it kept, and answers a name nothing here pairs without failing", async () => {
        const said: string[] = [];
        const forgot = await forgetSandbox("sandbox-2e8d89d75865", (line) => said.push(line), { here: true, mutagen: async () => undefined });
        expect(forgot.retired.map((entry) => entry.sandboxId)).toEqual([GONE]);
        expect(forgotInWords("sandbox-2e8d89d75865", forgot)).toContain(`kept ${workspace}`);
        expect((await readState()).pairings.map((pairing) => pairing.sandboxId)).toEqual([KEPT]);

        const nothing = await forgetSandbox("sandbox-unknown", () => undefined, { here: true, mutagen: async () => undefined });
        expect(nothing).toEqual({ ok: true, retired: [] });
        expect(forgotInWords("sandbox-unknown", nothing)).toBe("Nothing paired in this environment is called sandbox-unknown.");
    });

    it("reads each distro's answer as its JSON, or its own words when it has none", () => {
        expect(
            distroAnswer(
                "wsl:Ubuntu",
                0,
                `noise\n${JSON.stringify({ ok: true, retired: [{ sandboxId: GONE, pairings: [GONE], folders: [] }] })}\n`,
                "",
            ),
        ).toEqual({
            environment: "wsl:Ubuntu",
            ok: true,
            retired: [{ sandboxId: GONE, pairings: [GONE], folders: [] }],
        });
        expect(distroAnswer("wsl:Ubuntu", 1, JSON.stringify({ ok: false, error: "sync.json did not read" }), "")).toEqual({
            environment: "wsl:Ubuntu",
            ok: false,
            error: "sync.json did not read",
        });
        // An agent older than the verb.
        expect(distroAnswer("wsl:Arch", 252, "", "No command registered for `forget`\n")).toEqual({
            environment: "wsl:Arch",
            ok: false,
            error: "No command registered for `forget`",
        });
    });
});

describe("a sandbox said to be gone", () => {
    const seams = async (mutagen: string) => {
        const said: string[] = [];
        const released: string[] = [];
        return {
            said,
            released,
            fate: {
                mutagen,
                releaseForwards: async (sandboxId: string) => void released.push(sandboxId),
                say: (line: string) => void said.push(line),
            },
        };
    };

    it("is marked once on every pairing of it, held still with its own reason, and its ports released; a recheck only moves the clock", async () => {
        const mutagen = await fakeMutagen({ sync: `intentic-${GONE} intentic-${GONE}-state` });
        const { said, released, fate } = await seams(mutagen.path);

        await sandboxSaidGone(fate, GONE, "edge", 1_000);
        const marked = (await readState()).pairings.find((pairing) => pairing.sandboxId === GONE);
        expect(marked).toMatchObject({ goneSince: 1_000, goneCheckedAt: 1_000, goneBy: "edge", fileSyncPausedFor: "gone" });
        expect(released).toEqual([GONE]);
        expect(said).toHaveLength(1);
        expect(said[0]).toContain("the platform says this sandbox no longer exists");

        await sandboxSaidGone(fate, GONE, "local", 5_000);
        expect((await readState()).pairings.find((pairing) => pairing.sandboxId === GONE)).toMatchObject({
            goneSince: 1_000,
            goneCheckedAt: 5_000,
            goneBy: "edge",
        });
        expect(said).toHaveLength(1);
        // The sandbox kept syncing beside it is untouched.
        expect((await readState()).pairings.find((pairing) => pairing.sandboxId === KEPT)?.goneSince).toBeUndefined();
    });

    it("is unmarked and resumed by its own answer", async () => {
        const mutagen = await fakeMutagen({ sync: `intentic-${GONE} intentic-${GONE}-state` });
        const { said, fate } = await seams(mutagen.path);
        await sandboxSaidGone(fate, GONE, "edge", 1_000);

        await sandboxAnswered(fate, GONE);

        const back = (await readState()).pairings.find((pairing) => pairing.sandboxId === GONE);
        expect(back?.goneSince).toBeUndefined();
        expect(back?.fileSyncPausedFor).toBeUndefined();
        expect(said.at(-1)).toContain("answers again");
    });

    it("is gone on this machine's word only for a sandbox kept here, once ic's listing and trash both lack it", async () => {
        const mutagen = await fakeMutagen();
        const { fate } = await seams(mutagen.path);
        const listed = { listed: ["sandbox-0738cd6b5027"], trashed: [] };

        // Neither pairing is known to be kept here: ic is not even asked.
        let asked = 0;
        await checkKeptHere(fate, (await readState()).pairings, new Set(), async () => {
            asked += 1;
            return listed;
        });
        expect(asked).toBe(0);

        // Both reached on loopback this pass: the listed one is recorded as kept here, the other is unknown to ic but was
        // never known to it either, so nothing is concluded of it yet.
        await checkKeptHere(fate, (await readState()).pairings, new Set([GONE, KEPT]), async () => listed);
        expect((await readState()).pairings.find((pairing) => pairing.sandboxId === KEPT)?.icSlug).toBe("sandbox-0738cd6b5027");
        expect((await readState()).pairings.find((pairing) => pairing.sandboxId === GONE)?.goneSince).toBeUndefined();

        // Once kept here, absent from ic's listing and its trash: gone. Absent but trashed, or ic not answering: not.
        await checkKeptHere(fate, (await readState()).pairings, new Set(), async () => ({ listed: [], trashed: ["sandbox-0738cd6b5027"] }));
        expect((await readState()).pairings.find((pairing) => pairing.sandboxId === KEPT)?.goneSince).toBeUndefined();
        await checkKeptHere(fate, (await readState()).pairings, new Set(), async () => ({ listed: undefined, trashed: undefined }));
        expect((await readState()).pairings.find((pairing) => pairing.sandboxId === KEPT)?.goneSince).toBeUndefined();
        await checkKeptHere(fate, (await readState()).pairings, new Set(), async () => ({ listed: [], trashed: [] }));
        expect((await readState()).pairings.find((pairing) => pairing.sandboxId === KEPT)).toMatchObject({ goneBy: "local" });

        // Back in ic's listing (restored from its trash): ic withdraws what ic said.
        await checkKeptHere(fate, (await readState()).pairings, new Set(), async () => listed);
        expect((await readState()).pairings.find((pairing) => pairing.sandboxId === KEPT)?.goneSince).toBeUndefined();
    });

    // (2026-10-06) A sandbox that moved to another computer keeps its address: ic here holds it nowhere, yet it answers.
    // Marked gone on ic's word, it was unmarked by its own answer at the hourly recheck and marked again minutes later,
    // for ever. Its answer outweighs this machine's ic.
    it("is not gone on this machine's word while the sandbox still answers at its address", async () => {
        const mutagen = await fakeMutagen();
        const { said, fate } = await seams(mutagen.path);
        await checkKeptHere(fate, (await readState()).pairings, new Set([KEPT]), async () => ({ listed: ["sandbox-0738cd6b5027"], trashed: [] }));
        expect((await readState()).pairings.find((pairing) => pairing.sandboxId === KEPT)?.icSlug).toBe("sandbox-0738cd6b5027");

        const empty = async () => ({ listed: [], trashed: [] });
        await checkKeptHere(fate, (await readState()).pairings, new Set(), empty, (sandboxId) => sandboxId === KEPT);
        expect((await readState()).pairings.find((pairing) => pairing.sandboxId === KEPT)?.goneSince).toBeUndefined();
        expect(said).toEqual([]);

        // Once it stops answering as well, ic's word stands.
        await checkKeptHere(fate, (await readState()).pairings, new Set(), empty, () => false);
        expect((await readState()).pairings.find((pairing) => pairing.sandboxId === KEPT)).toMatchObject({ goneBy: "local" });
    });
});

describe("a docker pairing whose container went away", () => {
    const BLOG = "sandbox-5a1b2c3d4e5f-intentic-dev";
    const BLOG_URL = "https://sandbox-5a1b2c3d4e5f.intentic.dev";
    const CONTAINER = "intentic-sandbox-sandbox-5a1b2c3d4e5f";
    const blog = {
        sandboxUrl: BLOG_URL,
        sandboxId: BLOG,
        mode: "sync" as const,
        syncToken: "ist_blog",
        localDir: join(home, "code", "blog"),
        remoteDir: `${WORKSPACE_ROOT}/blog`,
        project: true as const,
        transport: "docker" as const,
        container: CONTAINER,
    };
    const run = async (
        container: "serves" | "stopped" | "missing" | "unknown",
        local: { listed?: string[]; trashed?: string[] },
        answering: boolean,
    ) => {
        const mutagen = await fakeMutagen({ sync: `intentic-${BLOG}` });
        const said: string[] = [];
        await checkContainers(
            { mutagen: mutagen.path, releaseForwards: async () => undefined, say: (line) => void said.push(line) },
            (await readState()).pairings,
            () => answering,
            { state: async () => container, read: async () => ({ listed: local.listed, trashed: local.trashed }) },
        );
        return { said, pairing: (await readState()).pairings.find((pairing) => pairing.sandboxId === BLOG) };
    };

    beforeEach(async () => {
        await upsertPairing(blog);
    });

    it("keeps a container that serves, or one only stopped", async () => {
        expect((await run("serves", {}, true)).pairing).toMatchObject({ transport: "docker", container: CONTAINER });
        expect((await run("stopped", {}, false)).pairing?.fileSyncPausedFor).toBeUndefined();
    });

    it("moves onto ssh when ic cannot say and the sandbox still answers at its address", async () => {
        const { pairing, said } = await run("missing", {}, true);
        expect(pairing?.transport).toBeUndefined();
        expect(pairing?.container).toBeUndefined();
        expect(said.join("\n")).toContain("moves to ssh");
    });

    // (2026-10-06) Moved to another computer: ic here holds it nowhere, and it answers at its address from there.
    it("moves onto ssh rather than marking it gone when ic holds it nowhere but the sandbox still answers", async () => {
        const { pairing, said } = await run("missing", { listed: [], trashed: [] }, true);
        expect(pairing?.goneSince).toBeUndefined();
        expect(pairing?.transport).toBeUndefined();
        expect(said.join("\n")).toContain("moves to ssh");
    });

    it("pauses with ic's trash as the reason, and marks the sandbox gone when ic holds it nowhere", async () => {
        expect((await run("missing", { listed: [], trashed: ["sandbox-5a1b2c3d4e5f"] }, false)).pairing?.fileSyncPausedFor).toBe("container-trashed");
        await upsertPairing(blog);
        expect((await run("missing", { listed: [], trashed: [] }, false)).pairing).toMatchObject({ goneBy: "local" });
    });

    it("lifts its own pause once the container serves again", async () => {
        await run("missing", {}, false);
        expect((await readState()).pairings.find((pairing) => pairing.sandboxId === BLOG)?.fileSyncPausedFor).toBe("container-missing");
        const { pairing, said } = await run("serves", {}, true);
        expect(pairing?.fileSyncPausedFor).toBeUndefined();
        expect(said.join("\n")).toContain("runs as this sandbox again");
    });
});

describe("unbridgeRepos", () => {
    // Three repos under the folder: one the bridge followed for this sandbox, one with a `sandbox` remote of the owner's
    // own pointing elsewhere, one with none.
    const tree: Record<string, readonly string[]> = { "/w": ["app", "lib", "node_modules"], "/w/app": [], "/w/lib": ["inner"], "/w/lib/inner": [] };
    const repos = new Set(["/w/app/.git", "/w/lib/.git", "/w/lib/inner/.git", "/w/node_modules/x/.git"]);
    const fs: UnbridgeFs = { subdirs: async (dir) => tree[dir] ?? [] };
    const ran: string[] = [];
    const exec: BridgeExec = {
        exists: (path) => repos.has(path),
        run: async (command, args, cwd) => {
            ran.push(`${cwd ?? ""}: ${command} ${args.join(" ")}`);
            if (args[0] === "remote" && args[1] === "get-url") {
                return cwd === "/w/app" ? "intentic-sync-x:/history/gits/app\n" : cwd === "/w/lib" ? "git@github.com:me/lib.git\n" : undefined;
            }
            if (args[0] === "for-each-ref") {
                return "refs/intentic/bridged/main\n";
            }
            return "";
        },
    };

    it("finds the repos the bridge could have followed, never under what file sync ignores", async () => {
        expect(await bridgedRepoCandidates(fs, exec, "/w")).toEqual(["/w/app", "/w/lib", "/w/lib/inner"]);
    });

    it("removes the remote and the markers only where the remote is this sandbox's", async () => {
        expect(await unbridgeRepos(exec, fs, "intentic-sync-x", "/w")).toBe(1);
        expect(ran.filter((line) => line.startsWith("/w/app:") && !line.includes("get-url"))).toEqual([
            "/w/app: git remote remove sandbox",
            "/w/app: git for-each-ref --format=%(refname) refs/intentic/bridged/",
            "/w/app: git update-ref -d refs/intentic/bridged/main",
        ]);
        expect(ran.some((line) => line.startsWith("/w/lib:") && line.includes("remove"))).toBe(false);
    });
});
