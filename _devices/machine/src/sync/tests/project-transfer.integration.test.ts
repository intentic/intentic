import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pidFileBody } from "@intentic/local-agent";
import { FAKE_DOCKER, FAKE_MUTAGEN, FAKE_SSH, type FakeProject, fakeProject, type FakeSessionState, mutagenConflict } from "../../testing.js";
import { HELD_CHANGED_HERE, HELD_NOT_RUNNING } from "../project-files.js";
import { listingRecordPath } from "../project-local.js";
import { mutagenSession, projectShell, sandboxCopy } from "../project-remote.js";
import { bringBack, projectChanges, type ProjectContext, type ProjectPairing, restorePoint, restorePoints } from "../project-transfer.js";
import { expiredPoints, pointId, type PointOnDisk, pruneRestorePoints, restoreDir } from "../restore-points.js";

// A COPY-FIRST PROJECT'S WAY BACK, end to end on temp trees: the sandbox's copy is a local folder behind a fake ssh that
// runs the real remote programs (src/testing.ts), and Mutagen a fake session whose pauses are recorded.

let root: string;
let local: string;
let remote: string;
let fake: FakeProject;
let context: ProjectContext;

const setUp = async (session: FakeSessionState = "running"): Promise<void> => {
    fake = fakeProject(session);
    const pairing: ProjectPairing = {
        sandboxUrl: "https://sandbox-a.example.dev",
        sandboxId: "sandbox-a",
        mode: "sync",
        localDir: local,
        remoteDir: remote,
        project: true,
    };
    context = {
        pairing,
        stateDir: join(root, "state"),
        sandbox: sandboxCopy(fake.runner, projectShell({ kind: "ssh", alias: "intentic-sync-sandbox-a" }, FAKE_SSH), remote),
        session: mutagenSession(fake.runner, FAKE_MUTAGEN, "intentic-sandbox-a"),
    };
};

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "copy-first-"));
    local = join(root, "local");
    remote = join(root, "remote");
    await mkdir(local);
    await mkdir(remote);
    await setUp();
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

const put = async (side: string, path: string, content: string): Promise<void> => {
    await mkdir(dirname(join(side, path)), { recursive: true });
    await writeFile(join(side, path), content);
};

// Both copies holding the same files, as a running copy-first session leaves them.
const same = async (path: string, content: string): Promise<void> => {
    await put(local, path, content);
    await put(remote, path, content);
};

const read = async (side: string, path: string): Promise<string | undefined> => await readFile(join(side, path), "utf8").catch(() => undefined);

// A name NUL framing has to carry whole: a space, a quote, a newline.
const ODD = "notes/a 'quoted'\nname.md";

describe("sync changes", () => {
    it("lists what the sandbox added and changed, by path, leaving ignored files and the sandbox's .git pointer out", async () => {
        await same("README.md", "# app\n");
        await same("src/index.ts", "export const a = 1;\n");
        await put(remote, "src/index.ts", "export const a = 2; // agent\n");
        await put(remote, ODD, "agent's notes");
        await put(remote, ".git", "gitdir: /history/gits/app\n");
        await put(remote, "node_modules/pkg/index.js", "module.exports = 1;\n");
        await put(remote, ".env.development.local", "TOKEN=sandbox\n");
        await put(local, ".env", "SECRET=local\n");
        // What Mutagen says of the edited file: it kept the sandbox's copy, and this device's is what the two last agreed on.
        fake.conflicts = [
            mutagenConflict("src/index.ts", {
                agreed: "export const a = 1;\n",
                here: "export const a = 1;\n",
                sandbox: "export const a = 2; // agent\n",
            }),
        ];

        expect(await projectChanges(context)).toEqual({
            ok: true,
            pairing: "sandbox-a",
            direction: "to-sandbox",
            changes: [
                { path: ODD, kind: "added", size: 13 },
                { path: "src/index.ts", kind: "modified", size: 29 },
            ],
        });
        // One ssh command lists the sandbox; the session is flushed first, so this device's edits are not mistaken for its,
        // and read again for the conflicts that cycle left.
        expect(fake.calls).toEqual(["mutagen list", "mutagen flush", "mutagen list", "ssh list"]);
    });

    // With neither Mutagen's word nor a listing that saw the two agree, a file both hold differently may be an edit here.
    it("marks a changed file nothing vouches for as a conflict", async () => {
        await same("a.ts", "one");
        await put(remote, "a.ts", "the agent's");
        expect((await projectChanges(context)).changes).toEqual([{ path: "a.ts", kind: "modified", size: 11, conflict: true }]);
    });

    // Copy-first's Mutagen puts back what an agent deletes, so a file only this device holds is most often one made here
    // and not yet carried over. It is offered as deleted only once a listing has seen the sandbox hold it too.
    it("offers a deletion only for a file the two copies were seen to agree on", async () => {
        await same("kept.txt", "kept");
        await same("old.txt", "old");
        await put(local, "new-here.txt", "made on this device");
        expect((await projectChanges(context)).changes).toEqual([]);

        await rm(join(remote, "old.txt"));
        expect((await projectChanges(context)).changes).toEqual([{ path: "old.txt", kind: "deleted" }]);
    });

    it("never offers an edit made on this device as the sandbox's", async () => {
        await same("a.ts", "one");
        await projectChanges(context);
        await put(local, "a.ts", "two, not carried over yet");
        expect((await projectChanges(context)).changes).toEqual([]);
        await put(remote, "a.ts", "three, the agent's");
        // Both moved away from what they agreed on: listed, as the conflict it is.
        expect((await projectChanges(context)).changes).toEqual([{ path: "a.ts", kind: "modified", size: 18, conflict: true }]);
    });

    it("refuses a folder that is not there, rather than offering the sandbox's every file", async () => {
        await put(remote, "a.ts", "agent");
        await rm(local, { recursive: true });
        await expect(projectChanges(context)).rejects.toThrow(`${local} is not there`);
    });

    it("says so when the sandbox has no copy at all", async () => {
        await rm(remote, { recursive: true });
        await expect(projectChanges(context)).rejects.toThrow(`the sandbox has no ${remote}: its copy of this folder is gone`);
    });
});

describe("sync bring-back and sync restore", () => {
    it("brings every change back after keeping a restore point, and a restore undoes it", async () => {
        await same("README.md", "# app\n");
        await same("src/index.ts", "one");
        await same("gone.txt", "the agent deleted this");
        await projectChanges(context);
        await put(remote, "src/index.ts", "two");
        await put(remote, ODD, "agent's notes");
        await rm(join(remote, "gone.txt"));
        fake.calls.length = 0;

        const brought = await bringBack(context, []);
        expect(brought).toEqual({
            ok: true,
            point: expect.stringMatching(/^\d{8}T\d{6}\.\d{3}Z$/),
            applied: [
                { path: "gone.txt", kind: "deleted" },
                { path: ODD, kind: "added" },
                { path: "src/index.ts", kind: "modified" },
            ],
            skipped: [],
        });
        expect([await read(local, "src/index.ts"), await read(local, ODD), await read(local, "gone.txt")]).toEqual([
            "two",
            "agent's notes",
            undefined,
        ]);
        // Held still from the listing to the last write, and let go after.
        expect(fake.calls).toEqual(["mutagen list", "mutagen flush", "mutagen list", "mutagen pause", "ssh list", "ssh fetch", "mutagen resume"]);
        expect(fake.session).toBe("running");

        const point = join(restoreDir(context.stateDir, "sandbox-a"), brought.point);
        expect(JSON.parse(await readFile(join(point, "manifest.json"), "utf8"))).toEqual({
            id: brought.point,
            createdAt: expect.any(String),
            dir: local,
            entries: [
                {
                    path: "gone.txt",
                    kind: "deleted",
                    backedUp: true,
                    applied: null,
                    backup: expect.stringMatching(/^[0-9a-f]{64}$/),
                    mode: expect.any(Number),
                },
                { path: ODD, kind: "added", backedUp: false, applied: expect.stringMatching(/^[0-9a-f]{64}$/) },
                {
                    path: "src/index.ts",
                    kind: "modified",
                    backedUp: true,
                    applied: expect.stringMatching(/^[0-9a-f]{64}$/),
                    backup: expect.stringMatching(/^[0-9a-f]{64}$/),
                    mode: expect.any(Number),
                },
            ],
        });
        expect([await read(point, "files/src/index.ts"), await read(point, "files/gone.txt")]).toEqual(["one", "the agent deleted this"]);
        expect(await restorePoints(context)).toEqual({ ok: true, points: [{ id: brought.point, createdAt: expect.any(String), entries: 3 }] });

        // Both copies now agree on what came back: nothing is left to bring back.
        expect((await projectChanges(context)).changes).toEqual([]);

        expect(await restorePoint(context, brought.point)).toEqual({ ok: true, restored: 3, skipped: [] });
        expect([await read(local, "src/index.ts"), await read(local, ODD), await read(local, "gone.txt")]).toEqual([
            "one",
            undefined,
            "the agent deleted this",
        ]);
        // The folder the added file sat in held nothing else, so it went too: the sandbox has none to carry it back to.
        await expect(lstat(join(local, "notes"))).rejects.toThrow("ENOENT");
        // Restoring again changes nothing, and says why.
        expect(await restorePoint(context, brought.point)).toEqual({
            ok: true,
            restored: 0,
            skipped: [
                { path: "gone.txt", reason: "it is already as it was before that bring-back" },
                { path: ODD, reason: "it is already as it was before that bring-back" },
                { path: "src/index.ts", reason: "it is already as it was before that bring-back" },
            ],
        });
    });

    it("never restores over a file changed here since the bring-back", async () => {
        await put(remote, "a.txt", "agent");
        const brought = await bringBack(context, []);
        await put(local, "a.txt", "my own edit since");
        expect(await restorePoint(context, brought.point)).toEqual({
            ok: true,
            restored: 0,
            skipped: [{ path: "a.txt", reason: "it changed here since that bring-back" }],
        });
        expect(await read(local, "a.txt")).toBe("my own edit since");
    });

    it("brings back only the paths asked for, a folder meaning everything under it, and names a path with no change", async () => {
        await put(remote, "src/a.ts", "a");
        await put(remote, "src/deep/b.ts", "b");
        await put(remote, "docs/c.md", "c");
        const brought = await bringBack(context, ["src", "nothing/here.txt"]);
        expect(brought.applied).toEqual([
            { path: "src/a.ts", kind: "added" },
            { path: "src/deep/b.ts", kind: "added" },
        ]);
        expect(brought.skipped).toEqual([{ path: "nothing/here.txt", reason: "the sandbox's copy has no change to bring back there" }]);
        expect(await read(local, "docs/c.md")).toBeUndefined();
    });

    it("skips a file that changed in the sandbox after it was listed, and keeps nothing of it in the restore point", async () => {
        await put(remote, "a.txt", "listed");
        await put(remote, "b.txt", "steady");
        fake.before.fetch = async () => await put(remote, "a.txt", "rewritten after the listing");
        const brought = await bringBack(context, []);
        expect(brought.applied).toEqual([{ path: "b.txt", kind: "added" }]);
        expect(brought.skipped).toEqual([{ path: "a.txt", reason: "it changed in the sandbox after it was listed; bring it back again" }]);
        expect(await read(local, "a.txt")).toBeUndefined();
        expect((await restorePoints(context)).points.map((point) => point.entries)).toEqual([1]);
    });

    it("never writes through a link on this device, nor carries one from the sandbox", async () => {
        const outside = join(root, "outside");
        await mkdir(outside);
        await writeFile(join(outside, "secret"), "keep");
        await symlink(outside, join(local, "linked"));
        await put(remote, "linked/secret", "replaced by the agent");
        await symlink("/etc/passwd", join(remote, "passwd"));
        const brought = await bringBack(context, []);
        expect(brought.applied).toEqual([]);
        expect(brought.skipped).toEqual([{ path: "linked/secret", reason: "linked is not a plain folder here" }]);
        expect(await readFile(join(outside, "secret"), "utf8")).toBe("keep");
        await expect(lstat(join(local, "passwd"))).rejects.toThrow("ENOENT");
    });

    it("gives a file the sandbox made executable the same bit here", async () => {
        await put(remote, "run.sh", "#!/bin/sh\n");
        await chmod(join(remote, "run.sh"), 0o755);
        await bringBack(context, []);
        expect((await lstat(join(local, "run.sh"))).mode & 0o100).toBe(0o100);
    });
});

// A project whose sandbox runs on this machine's own engine brings its changes back through `docker exec` (endpoint.ts):
// the same listing and fetch programs, handed to `sh -c` in the container, so a bring-back is the same either way.
describe("a bring-back through Docker", () => {
    beforeEach(() => {
        const shell = projectShell({ kind: "docker", container: "intentic-sandbox-sandbox-a" }, FAKE_SSH);
        context = { ...context, sandbox: sandboxCopy(fake.runner, { ...shell, command: FAKE_DOCKER }, remote) };
    });

    it("lists and fetches through docker exec, and lands what the agent changed after a restore point", async () => {
        await same("src/index.ts", "one");
        await projectChanges(context);
        await put(remote, "src/index.ts", "two");
        await put(remote, ODD, "agent's notes");
        fake.calls.length = 0;

        const brought = await bringBack(context, []);
        expect(brought.applied).toEqual([
            { path: ODD, kind: "added" },
            { path: "src/index.ts", kind: "modified" },
        ]);
        expect(brought.point).toMatch(/^\d{8}T\d{6}\.\d{3}Z$/);
        expect([await read(local, "src/index.ts"), await read(local, ODD)]).toEqual(["two", "agent's notes"]);
        expect(fake.calls).toEqual(["mutagen list", "mutagen flush", "mutagen list", "mutagen pause", "docker list", "docker fetch", "mutagen resume"]);
    });
});

describe("the session around a bring-back", () => {
    // A pause somebody made is theirs to lift; a folder with no session has nothing to hold still.
    it("leaves a session paused by somebody else paused, and runs without one", async () => {
        await setUp("paused");
        await put(remote, "a.txt", "agent");
        await bringBack(context, []);
        expect([fake.calls, fake.session]).toEqual([["mutagen list", "ssh list", "ssh fetch"], "paused"]);

        await setUp("absent");
        await put(remote, "b.txt", "agent");
        expect((await bringBack(context, [])).applied).toEqual([{ path: "b.txt", kind: "added" }]);
        expect(fake.calls).toEqual(["mutagen list", "ssh list", "ssh fetch"]);
    });

    it("lets the session go again when the bring-back fails", async () => {
        await put(remote, "a.txt", "agent");
        fake.before.list = async () => await rm(remote, { recursive: true });
        await expect(bringBack(context, [])).rejects.toThrow("its copy of this folder is gone");
        expect(fake.session).toBe("running");
    });

    // A bring-back killed between its pause and its resume leaves a pause nobody would lift; the next command lifts it.
    it("lifts a pause an operation left behind", async () => {
        await setUp("paused");
        await mkdir(restoreDir(context.stateDir, "sandbox-a"), { recursive: true });
        await writeFile(join(restoreDir(context.stateDir, "sandbox-a"), ".paused"), "12345\n");
        await projectChanges(context);
        expect([fake.calls.slice(0, 2), fake.session]).toEqual([["mutagen resume", "mutagen list"], "running"]);
    });

    it("refuses a second bring-back while one is running", async () => {
        const dir = restoreDir(context.stateDir, "sandbox-a");
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, ".operation.pid"), await pidFileBody({ pid: process.ppid }));
        await expect(bringBack(context, [])).rejects.toThrow(`another bring-back, restore or delivery for ${local} is running (pid ${process.ppid})`);
    });
});

describe("never over a newer edit here", () => {
    const sha256 = (content: string): string => createHash("sha256").update(content).digest("hex");

    // THE REVIEWED SEQUENCE: a listing recorded that the two agreed on v1; the owner wrote v2 and the session carried it
    // to the sandbox; the sync was paused and the owner wrote v3. The sandbox's v2 differs from the record, and bringing
    // it back used to put the owner's older v2 over their newer v3.
    it("holds a file whose record went stale instead of bringing the owner's older copy back over the newer", async () => {
        await same("notes.md", "v1");
        await projectChanges(context);
        await same("notes.md", "v2");
        await put(local, "notes.md", "v3");
        await setUp("paused");
        expect((await projectChanges(context)).changes).toEqual([{ path: "notes.md", kind: "modified", size: 2, conflict: true }]);
        expect(await bringBack(context, [])).toEqual({
            ok: true,
            point: expect.stringMatching(/^\d{8}T/),
            applied: [],
            skipped: [{ path: "notes.md", reason: HELD_NOT_RUNNING }],
        });
        // Running again, the record still says v1 and this device's v3 moved away from it too: still held, asked for or not.
        await setUp("running");
        expect((await bringBack(context, ["notes.md"])).skipped).toEqual([{ path: "notes.md", reason: HELD_CHANGED_HERE }]);
        expect(await read(local, "notes.md")).toBe("v3");
    });

    it("holds every changed file when the flush could not finish a cycle", async () => {
        await same("a.txt", "one");
        await projectChanges(context);
        await put(remote, "a.txt", "agent");
        fake.flushes = false;
        expect((await projectChanges(context)).changes).toEqual([{ path: "a.txt", kind: "modified", size: 5, conflict: true }]);
        expect((await bringBack(context, [])).skipped).toEqual([{ path: "a.txt", reason: HELD_NOT_RUNNING }]);
        expect(await read(local, "a.txt")).toBe("one");
    });

    // Mutagen's record of the last agreement is fresh every cycle: with no listing record yet (a new project's first
    // review), what it reports is what tells the agent's edit from both sides' edits.
    it("brings back what Mutagen reports the sandbox alone changed, and holds what it reports both changed", async () => {
        await same("a.txt", "orig");
        await same("b.txt", "orig");
        await put(remote, "a.txt", "agent a");
        await put(remote, "b.txt", "agent b");
        await put(local, "b.txt", "mine");
        fake.conflicts = [
            mutagenConflict("a.txt", { agreed: "orig", here: "orig", sandbox: "agent a" }),
            mutagenConflict("b.txt", { agreed: "orig", here: "mine", sandbox: "agent b" }),
        ];
        expect((await projectChanges(context)).changes).toEqual([
            { path: "a.txt", kind: "modified", size: 7 },
            { path: "b.txt", kind: "modified", size: 7, conflict: true },
        ]);
        const brought = await bringBack(context, []);
        expect([brought.applied, brought.skipped]).toEqual([[{ path: "a.txt", kind: "modified" }], [{ path: "b.txt", reason: HELD_CHANGED_HERE }]]);
        expect([await read(local, "a.txt"), await read(local, "b.txt")]).toEqual(["agent a", "mine"]);
    });

    // Mutagen vouches for the file its last cycle saw: an edit here since is not that file.
    it("does not take Mutagen's word for a file edited here after its cycle", async () => {
        await same("a.txt", "orig");
        await put(remote, "a.txt", "agent");
        fake.conflicts = [mutagenConflict("a.txt", { agreed: "orig", here: "orig", sandbox: "agent" })];
        await put(local, "a.txt", "edited since");
        expect((await projectChanges(context)).changes).toEqual([{ path: "a.txt", kind: "modified", size: 5, conflict: true }]);
    });

    // A listing beside a running bring-back leaves the record to it, so it can never undo what that one recorded.
    it("writes no record while another operation holds the folder", async () => {
        await same("a.txt", "one");
        const dir = restoreDir(context.stateDir, "sandbox-a");
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, ".operation.pid"), await pidFileBody({ pid: process.ppid }));
        await projectChanges(context);
        expect(existsSync(listingRecordPath(context.stateDir, "sandbox-a"))).toBe(false);
        await rm(join(dir, ".operation.pid"));
        await projectChanges(context);
        expect(JSON.parse(await readFile(listingRecordPath(context.stateDir, "sandbox-a"), "utf8")).agreed).toEqual({ "a.txt": sha256("one") });
    });
});

describe("the restore point on the disk", () => {
    // A crash right after the folder is rewritten must find the copies it replaced: every one of them, the manifest and
    // the folders holding them are flushed before the first write here.
    it("is flushed, copies, folders and all, before the first file here is written", async () => {
        await same("src/a.ts", "one");
        await projectChanges(context);
        await put(remote, "src/a.ts", "two");
        const flushed: string[] = [];
        const before: boolean[] = [];
        const watch = async (what: string): Promise<void> => {
            flushed.push(what);
            before.push((await read(local, "src/a.ts")) === "one");
        };
        context = {
            ...context,
            durability: { file: async (path) => await watch(`file ${path}`), folder: async (path) => await watch(`folder ${path}`) },
        };
        const brought = await bringBack(context, []);
        const restore = restoreDir(context.stateDir, "sandbox-a");
        const point = join(restore, brought.point);
        expect(flushed).toEqual([
            `file ${join(point, "files", "src", "a.ts")}`,
            `folder ${join(point, "files", "src")}`,
            `folder ${join(point, "files")}`,
            `folder ${point}`,
            `folder ${restore}`,
        ]);
        expect(before).toEqual([true, true, true, true, true]);
        expect(await read(local, "src/a.ts")).toBe("two");
    });
});

describe("restore point retention", () => {
    const now = Date.parse("2026-09-28T12:00:00.000Z");
    const day = 24 * 60 * 60_000;
    const ids = (ages: readonly number[]): string[] => ages.map((age) => pointId(new Date(now - age)));
    const holding = (ages: readonly number[], held: PointOnDisk["holding"] = "files"): PointOnDisk[] =>
        ids(ages).map((id) => ({ id, holding: held }));

    it("keeps the newest twenty that hold files, and every such point younger than thirty days besides", () => {
        const old = holding(Array.from({ length: 25 }, (_, at) => 40 * day + at * 1000));
        expect(expiredPoints(old, now)).toEqual(ids(Array.from({ length: 5 }, (_, at) => 40 * day + (20 + at) * 1000)).toSorted());
        expect(expiredPoints(holding(Array.from({ length: 25 }, (_, at) => at * 1000)), now)).toEqual([]);
        // The boundary: a point beyond the newest twenty goes at thirty days old, not a millisecond before.
        const edge = [...holding(Array.from({ length: 20 }, (_, at) => at * 1000)), ...holding([30 * day - 1, 30 * day])];
        expect(expiredPoints(edge, now)).toEqual(ids([30 * day]));
    });

    // An empty bring-back used to keep a point that counted toward the twenty, and pushed a real one out.
    it("never counts a point that holds nothing, and clears it unless it is the answer just given", () => {
        const kept = holding(Array.from({ length: 20 }, (_, at) => 40 * day + at * 1000));
        const empty = holding([1000, 2000], "nothing");
        const cutOff = holding([3000], "unfinished");
        expect(expiredPoints([...kept, ...empty, ...cutOff], now, ids([1000])[0])).toEqual(ids([2000, 3000]).toSorted());
    });

    it("removes the expired points' folders and nothing else", async () => {
        const dir = restoreDir(context.stateDir, "sandbox-a");
        const all = ids(Array.from({ length: 22 }, (_, at) => 31 * day + at * 1000));
        for (const id of all) {
            await mkdir(join(dir, id), { recursive: true });
            await writeFile(
                join(dir, id, "manifest.json"),
                JSON.stringify({
                    id,
                    createdAt: new Date(now).toISOString(),
                    dir: local,
                    entries: [{ path: "a", kind: "added", backedUp: false, applied: "a".repeat(64) }],
                }),
            );
        }
        await mkdir(join(dir, ".staging-x"));
        await pruneRestorePoints(context.stateDir, "sandbox-a", now);
        expect((await readdir(dir)).toSorted()).toEqual([".staging-x", ...all.slice(0, 20)].toSorted());
    });

    it("keeps twenty real points through any number of bring-backs that wrote nothing", async () => {
        const dir = restoreDir(context.stateDir, "sandbox-a");
        const real = ids(Array.from({ length: 20 }, (_, at) => 40 * day + at * 1000));
        for (const id of real) {
            await mkdir(join(dir, id), { recursive: true });
            await writeFile(
                join(dir, id, "manifest.json"),
                JSON.stringify({
                    id,
                    createdAt: new Date(now).toISOString(),
                    dir: local,
                    entries: [{ path: "a", kind: "added", backedUp: false, applied: "a".repeat(64) }],
                }),
            );
        }
        const answers: string[] = [];
        for (let round = 0; round < 3; round += 1) {
            answers.push((await bringBack(context, [])).point);
        }
        expect((await readdir(dir)).filter((name) => /^\d{8}T/.test(name)).toSorted()).toEqual([...real, ...answers.slice(2)].toSorted());
        // Newest first, and none of the empty ones.
        expect((await restorePoints(context)).points.map((point) => point.id)).toEqual(real);
    });
});
