import { link, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { WORKSPACE_ROOT } from "@intentic/constants";
import { PROJECT_DELIVERY_MAX_BYTES, type ProjectDelivery } from "@intentic/sandbox-contract";
import { FAKE_MUTAGEN, FAKE_SSH, type FakeProject, fakeProject } from "../../testing.js";
import { attachedKey, type Pairing } from "../config.js";
import { decodeDelivery, type DeliveryContext, type DeliveryRefused, deliveryPairingFor, deliverToFolder } from "../project-delivery.js";
import { mutagenSession, projectShell, sandboxCopy } from "../project-remote.js";
import { type ProjectPairing, restorePoint, restorePoints } from "../project-transfer.js";
import { restoreDir } from "../restore-points.js";

// LANDED WORK DELIVERED INTO AN ATTACHED FOLDER, end to end on a temp folder: the session is the fake Mutagen the
// copy-first suites share (src/testing.ts), git is this machine's own, and restore is the bring-back's own command.

const SANDBOX = "sandbox-5a1b2c3d4e5f-intentic-dev";
const URL_OF = "https://sandbox-5a1b2c3d4e5f.intentic.dev";

let root: string;
let local: string;
let fake: FakeProject;
let pairing: ProjectPairing;
let context: DeliveryContext;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "delivery-"));
    local = join(root, "shop");
    await mkdir(local);
    fake = fakeProject("running");
    pairing = {
        sandboxUrl: URL_OF,
        sandboxId: SANDBOX,
        key: attachedKey(SANDBOX, "shop"),
        mode: "sync",
        localDir: local,
        remoteDir: `${WORKSPACE_ROOT}/shop`,
        project: true,
        deliver: "auto",
    };
    context = { pairing, stateDir: join(root, "state"), session: mutagenSession(fake.runner, FAKE_MUTAGEN, "intentic-shop") };
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

const b64 = (text: string): string => Buffer.from(text).toString("base64");

const put = async (path: string, content: string | Buffer): Promise<void> => {
    await mkdir(dirname(join(local, path)), { recursive: true });
    await writeFile(join(local, path), content);
};

const read = async (path: string): Promise<string | undefined> => await readFile(join(local, path), "utf8").catch(() => undefined);

const delivery = (files: ProjectDelivery["files"]): ProjectDelivery => ({ remoteDir: `${WORKSPACE_ROOT}/shop`, files, landing: { agentId: "agent-1", title: "Add checkout" } });

const added = (path: string, next: string, executable?: boolean): ProjectDelivery["files"][number] => ({
    path,
    kind: "added",
    base: null,
    next: b64(next),
    ...(executable === undefined ? {} : { executable }),
});
const modified = (path: string, base: string, next: string): ProjectDelivery["files"][number] => ({ path, kind: "modified", base: b64(base), next: b64(next) });
const deleted = (path: string, base: string): ProjectDelivery["files"][number] => ({ path, kind: "deleted", base: b64(base), next: null });

describe("deliverProject", () => {
    it("writes a land the owner did not touch, a restore point first, with the session held still around it", async () => {
        await put("src/app.ts", "export const a = 1;\n");
        await put("old.txt", "old\n");

        const result = await deliverToFolder(
            context,
            delivery([added("src/new.ts", "export const n = 1;\n"), added("bin/run.sh", "#!/bin/sh\n", true), modified("src/app.ts", "export const a = 1;\n", "export const a = 2;\n"), deleted("old.txt", "old\n")]),
        );

        expect(result).toEqual({
            point: expect.stringMatching(/^\d{8}T\d{6}\.\d{3}Z$/),
            folder: local,
            applied: ["src/new.ts", "bin/run.sh", "src/app.ts", "old.txt"],
            merged: [],
            already: [],
            conflicts: [],
        });
        expect(await read("src/new.ts")).toBe("export const n = 1;\n");
        expect(await read("src/app.ts")).toBe("export const a = 2;\n");
        expect(await read("old.txt")).toBeUndefined();
        if (process.platform !== "win32") {
            expect((await stat(join(local, "bin/run.sh"))).mode & 0o111).not.toBe(0);
            expect((await stat(join(local, "src/new.ts"))).mode & 0o111).toBe(0);
        }
        // Flushed, then paused for the writes and let go again, as a bring-back holds it.
        expect(fake.calls).toEqual(["mutagen list", "mutagen flush", "mutagen list", "mutagen pause", "mutagen resume"]);
        expect(fake.session).toBe("running");
        const manifest = JSON.parse(await readFile(join(restoreDir(context.stateDir, pairing.key!), result.point!, "manifest.json"), "utf8")) as { landing: unknown; entries: unknown[] };
        expect(manifest.landing).toEqual({ agentId: "agent-1", title: "Add checkout" });
        expect(manifest.entries).toHaveLength(4);
    });

    // A file the owner made where the land adds one is theirs, unless it is the very same file.
    it("answers what the folder already holds, writing nothing and keeping no point", async () => {
        await put("same.ts", "landed\n");
        await put("there.ts", "the owner's own\n");
        await put("twin.ts", "landed\n");
        const result = await deliverToFolder(context, delivery([modified("same.ts", "before\n", "landed\n"), deleted("gone.txt", "x\n"), added("there.ts", "landed\n"), added("twin.ts", "landed\n")]));
        expect(result.point).toBeUndefined();
        expect(result.applied).toEqual([]);
        expect(result.conflicts).toEqual([{ path: "there.ts", reason: "edited" }]);
        expect(result.already).toEqual(["same.ts", "gone.txt", "twin.ts"]);
        expect(await read("there.ts")).toBe("the owner's own\n");
        await expect(restorePoints({ pairing, stateDir: context.stateDir })).resolves.toEqual({ ok: true, points: [] });
    });

    it("merges an owner's edit with the landed change when the two do not touch, and answers the merge", async () => {
        await put("notes.md", "Title\none\ntwo\nthree\nfour\nfive\nOWNER\n");
        const result = await deliverToFolder(context, delivery([modified("notes.md", "Title\none\ntwo\nthree\nfour\nfive\nsix\n", "TITLE\none\ntwo\nthree\nfour\nfive\nsix\n")]));
        const merged = "TITLE\none\ntwo\nthree\nfour\nfive\nOWNER\n";
        expect(result.merged).toEqual([{ path: "notes.md", content: b64(merged) }]);
        expect(result.applied).toEqual([]);
        expect(result.point).toEqual(expect.any(String));
        expect(await read("notes.md")).toBe(merged);
    });

    it("leaves an owner's edit that clashes with the land as the owner has it", async () => {
        await put("a.ts", "owner's\n");
        const result = await deliverToFolder(context, delivery([modified("a.ts", "base\n", "landed\n")]));
        expect(result).toEqual({ folder: local, applied: [], merged: [], already: [], conflicts: [{ path: "a.ts", reason: "edited" }] });
        expect(await read("a.ts")).toBe("owner's\n");
    });

    it("never merges what is not text, nor a file the owner deleted, nor a deletion of one the owner changed", async () => {
        await put("logo.png", Buffer.from([0x89, 0x50, 0x00, 0x01]));
        await put("changed.txt", "owner's\n");
        const binary = { path: "logo.png", kind: "modified" as const, base: Buffer.from([1, 0, 2]).toString("base64"), next: Buffer.from([3, 0, 4]).toString("base64") };
        const result = await deliverToFolder(context, delivery([binary, modified("removed-here.ts", "a\n", "b\n"), deleted("changed.txt", "base\n")]));
        expect(result.conflicts).toEqual([
            { path: "logo.png", reason: "edited" },
            { path: "removed-here.ts", reason: "edited" },
            { path: "changed.txt", reason: "edited" },
        ]);
        expect(await read("changed.txt")).toBe("owner's\n");
        expect(await read("removed-here.ts")).toBeUndefined();
    });

    it("says a merge needed git where this machine has none", async () => {
        await put("a.ts", "one\ntwo\nthree\nfour\nOWNER\n");
        const result = await deliverToFolder({ ...context, git: async () => undefined }, delivery([modified("a.ts", "one\ntwo\nthree\nfour\nfive\n", "ONE\ntwo\nthree\nfour\nfive\n")]));
        expect(result.conflicts).toEqual([{ path: "a.ts", reason: "missing-git" }]);
    });

    it("writes nothing through a link, into .git, or outside the folder", async () => {
        const outside = join(root, "outside");
        await mkdir(outside);
        await symlink(outside, join(local, "linked"));
        await writeFile(join(outside, "target.txt"), "theirs\n");
        await symlink(join(outside, "target.txt"), join(local, "pointer.txt"));
        const result = await deliverToFolder(
            context,
            delivery([added("linked/new.ts", "x\n"), modified("pointer.txt", "theirs\n", "landed\n"), added(".git/hooks/pre-commit", "x\n"), added("src/.GIT/config", "x\n"), added("../escape.txt", "x\n")]),
        );
        expect(result.conflicts).toEqual([
            { path: "linked/new.ts", reason: "link" },
            { path: "pointer.txt", reason: "link" },
            { path: ".git/hooks/pre-commit", reason: "outside" },
            { path: "src/.GIT/config", reason: "outside" },
            { path: "../escape.txt", reason: "outside" },
        ]);
        expect(await readFile(join(outside, "target.txt"), "utf8")).toBe("theirs\n");
        await expect(lstat(join(outside, "new.ts"))).rejects.toThrow();
        await expect(lstat(join(root, "escape.txt"))).rejects.toThrow();
    });

    // A disk that ignores case (NTFS, APFS) holds both spellings of a name as ONE file, the way two hard links name one
    // file here: the same device and inode under either spelling, which is what the delivery asks of the disk.
    // A case-only rename arrives as the old spelling deleted and the new one added, and must not delete that file.
    it("never deletes the file a case-only rename keeps, where both spellings are one file", async () => {
        await put("Readme.md", "# shop\n");
        await link(join(local, "Readme.md"), join(local, "README.md"));
        const result = await deliverToFolder(context, delivery([added("README.md", "# shop\n"), deleted("Readme.md", "# shop\n")]));
        expect(result.applied).toEqual([]);
        expect(result.already).toEqual(["README.md", "Readme.md"]);
        expect(await read("README.md")).toBe("# shop\n");
        expect(await read("Readme.md")).toBe("# shop\n");
    });

    it("writes a case-only rename that also changed the file as a change of the old spelling's content", async () => {
        await put("Readme.md", "# shop\n");
        await link(join(local, "Readme.md"), join(local, "README.md"));
        const result = await deliverToFolder(context, delivery([added("README.md", "# shop, renamed\n"), deleted("Readme.md", "# shop\n")]));
        expect(result.conflicts).toEqual([]);
        expect(result.applied).toEqual(["README.md"]);
        expect(result.already).toEqual(["Readme.md"]);
        expect(await read("README.md")).toBe("# shop, renamed\n");
        expect((await readdir(local)).toSorted()).toEqual(["README.md", "Readme.md"]);
    });

    // Two files that only share a spelling's case are two files on a disk that keeps case, and each goes as landed.
    it("deletes a file whose other spelling is a file of its own", async () => {
        await put("Readme.md", "# old\n");
        const result = await deliverToFolder(context, delivery([added("README.md", "# new\n"), deleted("Readme.md", "# old\n")]));
        expect(result.applied).toEqual(["README.md", "Readme.md"]);
        expect(await read("Readme.md")).toBeUndefined();
        expect(await read("README.md")).toBe("# new\n");
    });

    // The point is the bring-back's own, so the bring-back's own restore undoes a delivery unchanged.
    it("is undone by `sync restore --point`", async () => {
        await put("src/app.ts", "v1\n");
        await put("old.txt", "old\n");
        await put("notes.md", "Title\none\ntwo\nthree\nfour\nfive\nOWNER\n");
        const result = await deliverToFolder(
            context,
            delivery([added("src/new.ts", "new\n"), modified("src/app.ts", "v1\n", "v2\n"), deleted("old.txt", "old\n"), modified("notes.md", "Title\none\ntwo\nthree\nfour\nfive\nsix\n", "TITLE\none\ntwo\nthree\nfour\nfive\nsix\n")]),
        );
        expect((await restorePoints({ pairing, stateDir: context.stateDir })).points).toEqual([{ id: result.point!, createdAt: expect.any(String), entries: 4 }]);

        const restoring = { ...context, sandbox: sandboxCopy(fake.runner, projectShell({ kind: "ssh", alias: "unused" }, FAKE_SSH), `${WORKSPACE_ROOT}/shop`) };
        expect(await restorePoint(restoring, result.point!)).toEqual({ ok: true, restored: 4, skipped: [] });
        expect(await read("src/new.ts")).toBeUndefined();
        expect(await read("src/app.ts")).toBe("v1\n");
        expect(await read("old.txt")).toBe("old\n");
        expect(await read("notes.md")).toBe("Title\none\ntwo\nthree\nfour\nfive\nOWNER\n");
    });

    it("leaves a session somebody paused as it is, and delivers all the same", async () => {
        fake.session = "paused";
        const result = await deliverToFolder(context, delivery([added("a.ts", "a\n")]));
        expect(result.applied).toEqual(["a.ts"]);
        expect(fake.calls).toEqual(["mutagen list"]);
        expect(fake.session).toBe("paused");
    });

    it("refuses a folder that is not there rather than making one", async () => {
        await rm(local, { recursive: true });
        await expect(deliverToFolder(context, delivery([added("a.ts", "a\n")]))).rejects.toThrow(`${local} is not there`);
    });
});

describe("which folder a delivery is for", () => {
    const shop: Pairing = { sandboxUrl: URL_OF, sandboxId: SANDBOX, key: attachedKey(SANDBOX, "shop"), mode: "sync", localDir: "/home/ada/shop", remoteDir: `${WORKSPACE_ROOT}/shop`, project: true, deliver: "auto" };
    const handPicked: Pairing = { ...shop, key: attachedKey(SANDBOX, "blog"), localDir: "/home/ada/blog", remoteDir: `${WORKSPACE_ROOT}/blog`, deliver: "off" };
    const otherSandbox: Pairing = { ...shop, sandboxUrl: "https://sandbox-0738cd6b5027.intentic.dev", sandboxId: "sandbox-0738cd6b5027-intentic-dev", key: undefined, remoteDir: `${WORKSPACE_ROOT}/site`, localDir: "/home/ada/site" };

    it("finds the attached folder of the sandbox on the link's other end", () => {
        expect(deliveryPairingFor([otherSandbox, handPicked, shop], `${URL_OF}/`, `${WORKSPACE_ROOT}/shop`).localDir).toBe("/home/ada/shop");
    });

    it("refuses a folder that did not opt into delivery, and one of another sandbox", () => {
        const refusal = (run: () => unknown): DeliveryRefused => {
            try {
                run();
            } catch (error) {
                return error as DeliveryRefused;
            }
            throw new Error("not refused");
        };
        expect(refusal(() => deliveryPairingFor([handPicked], URL_OF, `${WORKSPACE_ROOT}/blog`))).toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("did not opt into delivery") });
        expect(refusal(() => deliveryPairingFor([{ ...handPicked, deliver: undefined }], URL_OF, `${WORKSPACE_ROOT}/blog`)).code).toBe("FORBIDDEN");
        expect(refusal(() => deliveryPairingFor([otherSandbox], URL_OF, `${WORKSPACE_ROOT}/site`))).toMatchObject({ code: "NOT_FOUND" });
        expect(refusal(() => deliveryPairingFor([shop], URL_OF, `${WORKSPACE_ROOT}/nothing`))).toMatchObject({ code: "NOT_FOUND" });
    });
});

describe("decodeDelivery", () => {
    it("refuses a delivery past the size one call may carry, before decoding it", () => {
        const big = "A".repeat(Math.ceil((PROJECT_DELIVERY_MAX_BYTES / 3) * 4) + 4);
        expect(() => decodeDelivery(delivery([{ path: "big.bin", kind: "added", base: null, next: big }]))).toThrow("past the");
    });

    it("refuses contents that are not base64, a kind that does not hold what it says, and a path twice", () => {
        expect(() => decodeDelivery(delivery([{ path: "a", kind: "added", base: null, next: "not base64!" }]))).toThrow("is not base64");
        expect(() => decodeDelivery(delivery([{ path: "a", kind: "added", base: b64("x"), next: b64("y") }]))).toThrow("says added");
        expect(() => decodeDelivery(delivery([added("a", "x"), added("a", "y")]))).toThrow("twice");
    });
});
