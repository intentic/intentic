import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, inflateRawSync } from "node:zlib";
import { createApp } from "../../../app.js";
import { clientFor, errorCode, proven } from "../../../harness/route-client.testing.js";
import { services } from "../../../harness/route-services.testing.js";
import { workspacePaths } from "../../workspace.js";
import { fakeFiles } from "../../workspace-slice.testing.js";
import { nameSelection } from "./workspace-download.js";
import { statWorkspaceFileSize } from "../workspace-files.js";

// The ZIP download of a selection, driven over HTTP as the browser drives it, against real files: the route walks and
// streams off disk, so a fake would only test the fake. The archive is read back through its central directory, the way
// every desktop unzipper reads it, and each entry's CRC checked against its bytes.

interface Unzipped {
    readonly name: string;
    readonly method: number;
    readonly mode: number;
    readonly bytes: Buffer;
}

const unzip = (zip: Buffer): Unzipped[] => {
    const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const count = zip.readUInt16LE(end + 10);
    let at = zip.readUInt32LE(end + 16);
    const out: Unzipped[] = [];
    for (let index = 0; index < count; index += 1) {
        expect(zip.readUInt32LE(at)).toBe(0x02014b50);
        const method = zip.readUInt16LE(at + 10);
        const crc = zip.readUInt32LE(at + 16);
        const compressed = zip.readUInt32LE(at + 20);
        const nameLength = zip.readUInt16LE(at + 28);
        const extraLength = zip.readUInt16LE(at + 30);
        const mode = zip.readUInt32LE(at + 38) >>> 16;
        const offset = zip.readUInt32LE(at + 42);
        const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
        const dataAt = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
        const raw = zip.subarray(dataAt, dataAt + compressed);
        const bytes = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
        expect(crc32(bytes)).toBe(crc);
        out.push({ name, method, mode, bytes });
        at += 46 + nameLength + extraLength + zip.readUInt16LE(at + 32);
    }
    return out;
};

const withTree = async (run: (root: string) => Promise<void>): Promise<void> => {
    const root = await mkdtemp(join(tmpdir(), "download-"));
    try {
        await mkdir(join(root, "app/src/deep"), { recursive: true });
        await mkdir(join(root, "app/empty"), { recursive: true });
        await writeFile(join(root, "app/src/index.ts"), "export const answer = 42;\n".repeat(50));
        await writeFile(join(root, "app/src/deep/photo.jpg"), Buffer.alloc(4096, 7));
        await writeFile(join(root, "app/run.sh"), "#!/bin/sh\necho hi\n");
        await chmod(join(root, "app/run.sh"), 0o755);
        await writeFile(join(root, "notes.md"), "# notes\n");
        await mkdir(join(root, "media"), { recursive: true });
        await writeFile(join(root, "media/a.mp4"), Buffer.alloc(2000, 1));
        await writeFile(join(root, "media/b.png"), Buffer.alloc(3000, 2));
        await run(root);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
};

const appOver = (root: string) =>
    createApp(
        services({
            workspace: workspacePaths(root),
            files: fakeFiles({ size: statWorkspaceFileSize }),
            auth: { authorize: async () => proven("o@x.com", "owner"), authorizeOwner: async () => {} },
        }),
    );

test("a folder and a file download as one ZIP, text deflated, pictures stored, the executable bit kept", async () => {
    await withTree(async (root) => {
        const app = appOver(root);
        const { ticket, filename } = await clientFor(app).workspace.downloadTicket({ paths: ["app", "notes.md"] });
        expect(filename).toBe("workspace (2 items).zip");
        const response = await app.request(`/workspace/download?ticket=${ticket}`);
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("application/zip");
        expect(response.headers.get("content-disposition")).toBe(`attachment; filename*=UTF-8''workspace%20(2%20items).zip`);
        // Something deflates, so the length is only known once written.
        expect(response.headers.get("content-length")).toBeNull();
        const entries = unzip(Buffer.from(await response.arrayBuffer()));
        expect(entries.map((entry) => entry.name)).toEqual([
            "app/",
            "app/empty/",
            "app/run.sh",
            "app/src/",
            "app/src/deep/",
            "app/src/deep/photo.jpg",
            "app/src/index.ts",
            "notes.md",
        ]);
        const byName = new Map(entries.map((entry) => [entry.name, entry]));
        expect(byName.get("app/src/index.ts")?.method).toBe(8);
        expect(byName.get("app/src/index.ts")?.bytes.toString()).toBe("export const answer = 42;\n".repeat(50));
        expect(byName.get("app/src/deep/photo.jpg")?.method).toBe(0);
        expect(byName.get("app/run.sh")?.mode).toBe(0o100755);
        // An empty folder survives as its own entry, typed as a directory.
        expect((byName.get("app/empty/")?.mode ?? 0) & 0o170000).toBe(0o040000);
    });
});

test("an archive of already-compressed files promises its exact length, so the browser can show progress", async () => {
    await withTree(async (root) => {
        const app = appOver(root);
        const { ticket, filename } = await clientFor(app).workspace.downloadTicket({ paths: ["media"] });
        expect(filename).toBe("media.zip");
        const response = await app.request(`/workspace/download?ticket=${ticket}`);
        const body = Buffer.from(await response.arrayBuffer());
        expect(Number(response.headers.get("content-length"))).toBe(body.length);
        expect(unzip(body).map((entry) => [entry.name, entry.bytes.length])).toEqual([
            ["media/", 0],
            ["media/a.mp4", 2000],
            ["media/b.png", 3000],
        ]);
    });
});

test("siblings from different folders keep the folders that tell them apart", async () => {
    await withTree(async (root) => {
        const app = appOver(root);
        const { ticket } = await clientFor(app).workspace.downloadTicket({ paths: ["app/src/index.ts", "app/run.sh", "app/src"] });
        const entries = unzip(Buffer.from(await (await app.request(`/workspace/download?ticket=${ticket}`)).arrayBuffer()));
        // index.ts rides inside src/, which was selected too.
        expect(entries.map((entry) => entry.name)).toEqual(["run.sh", "src/", "src/deep/", "src/deep/photo.jpg", "src/index.ts"]);
    });
});

test("a symlink is followed only to a file inside the workspace", async () => {
    await withTree(async (root) => {
        const outside = await mkdtemp(join(tmpdir(), "outside-"));
        try {
            await writeFile(join(outside, "secret"), "nope");
            await symlink(join(outside, "secret"), join(root, "app/leak"));
            await symlink(join(root, "notes.md"), join(root, "app/notes-link.md"));
            await symlink(join(root, "app/src"), join(root, "app/loop"));
            const app = appOver(root);
            const { ticket } = await clientFor(app).workspace.downloadTicket({ paths: ["app"] });
            const names = unzip(Buffer.from(await (await app.request(`/workspace/download?ticket=${ticket}`)).arrayBuffer())).map(
                (entry) => entry.name,
            );
            expect(names).toContain("app/notes-link.md");
            expect(names).not.toContain("app/leak");
            expect(names.some((name) => name.startsWith("app/loop"))).toBe(false);
        } finally {
            await rm(outside, { recursive: true, force: true });
        }
    });
});

test("the ticket is the only way in, and a missing or escaping path is refused at the mint", async () => {
    await withTree(async (root) => {
        const app = appOver(root);
        expect((await app.request("/workspace/download")).status).toBe(401);
        expect((await app.request("/workspace/download?ticket=forged")).status).toBe(401);
        // A media ticket is bound to a path, not a selection: it can't be replayed as a download.
        const media = await clientFor(app).workspace.mediaTicket({ path: "notes.md" });
        expect((await app.request(`/workspace/download?ticket=${media.ticket}`)).status).toBe(401);
        expect(await errorCode(clientFor(app).workspace.downloadTicket({ paths: ["missing"] }))).toBe("NOT_FOUND");
        expect(await errorCode(clientFor(app).workspace.downloadTicket({ paths: ["../../etc"] }))).toBe("BAD_REQUEST");
        // Something selected vanishing between the mint and the download is a 404 before any byte, not a broken file.
        const { ticket } = await clientFor(app).workspace.downloadTicket({ paths: ["notes.md", "media"] });
        await rm(join(root, "media"), { recursive: true });
        expect((await app.request(`/workspace/download?ticket=${ticket}`)).status).toBe(404);
    });
});

test("the archive is named after the one thing selected, or after the folder the selection shares", () => {
    expect(nameSelection(["a/b"], "workspace").filename).toBe("b.zip");
    expect(nameSelection(["a/b", "a/c/d"], "workspace").filename).toBe("a (2 items).zip");
    expect([...nameSelection(["a/b", "a/c/d"], "workspace").names]).toEqual([
        ["a/b", "b"],
        ["a/c/d", "c/d"],
    ]);
    expect(nameSelection(["x", "y"], "workspace").filename).toBe("workspace (2 items).zip");
    expect([...nameSelection(["a", "a/b", "a/"], "workspace").names]).toEqual([["a", "a"]]);
});
