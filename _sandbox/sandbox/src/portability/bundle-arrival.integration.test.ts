import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createGunzip, createGzip } from "node:zlib";
import { extract, pack } from "tar-stream";
import { nodeStream, webStream } from "@intentic/base/web-stream";
import { services } from "../harness/route-services.testing.js";
import { memoryCapabilitiesStore } from "../capabilities/capabilities-slice.testing.js";
import { testConfig } from "../testing.js";
import { fakeFiles } from "../workspace/workspace-slice.testing.js";
import { workspacePaths } from "../workspace/workspace.js";
import { BUNDLE_MANIFEST_ENTRY, packBundle } from "./bundle.js";
import { applyBundle, bundleItems, dropSpool, spoolBundle } from "./bundle-arrival.js";

// A bundle is a file somebody hands over, so a crafted one is the case that matters: a symlink entry, then an entry
// written through it, must never put a byte outside the root it names. The manifest comes from the real packer, so only
// the entries after it are hand-made.

const LIMIT = 64 * 1024 * 1024;

let dir = "";
let work = "";
let history = "";
let outside = "";

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "intentic-bundle-escape-"));
    work = join(dir, "work");
    history = join(dir, "history");
    outside = join(dir, "outside");
    await Promise.all([work, history, outside].map((path) => mkdir(path, { recursive: true })));
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

// The manifest a real, empty export writes first.
const realManifest = async (): Promise<Buffer> => {
    const source = await mkdtemp(join(dir, "source-"));
    await mkdir(join(source, "work"));
    await mkdir(join(source, "history"));
    const stream = packBundle(
        services({
            workspace: workspacePaths(join(source, "work")),
            config: { ...testConfig, workspaceRoot: join(source, "work"), historyRoot: join(source, "history") },
            capabilities: memoryCapabilitiesStore([]),
            files: fakeFiles({ read: async (absPath) => readFile(absPath, "utf8").catch(() => undefined) }),
            vaultManifestSecrets: async () => [],
            vaultExtensionSettingSecrets: async () => [],
        } as Parameters<typeof services>[0]),
        { secrets: false, now: 1_700_000_000_000 },
    );
    const reader = Readable.fromWeb(nodeStream(stream)).pipe(createGunzip());
    return new Promise((resolve, reject) => {
        const ex = extract();
        let found: Buffer | undefined;
        ex.on("entry", (header, entry, next) => {
            const chunks: Buffer[] = [];
            entry.on("data", (chunk: unknown) => chunks.push(Buffer.from(chunk as Uint8Array)));
            entry.on("end", () => {
                if (header.name === BUNDLE_MANIFEST_ENTRY) {
                    found = Buffer.concat(chunks);
                }
                next();
            });
        });
        ex.on("finish", () => (found === undefined ? reject(new Error("no manifest in the real bundle")) : resolve(found)));
        ex.on("error", reject);
        reader.pipe(ex);
    });
};

type Crafted = { readonly name: string; readonly linkname: string } | { readonly name: string; readonly body: string };

const crafted = async (entries: readonly Crafted[]): Promise<ReadableStream<Uint8Array>> => {
    const manifest = await realManifest();
    const packer = pack();
    packer.entry({ name: BUNDLE_MANIFEST_ENTRY, type: "file" }, manifest);
    for (const entry of entries) {
        if ("linkname" in entry) {
            packer.entry({ name: entry.name, type: "symlink", linkname: entry.linkname });
        } else {
            packer.entry({ name: entry.name, type: "file" }, entry.body);
        }
    }
    packer.finalize();
    return webStream<Uint8Array>(Readable.toWeb(packer.pipe(createGzip())));
};

const arrive = async (bundle: ReadableStream<Uint8Array>) => {
    const held = await spoolBundle(bundle, history, LIMIT);
    const report = await applyBundle(
        held,
        { workspaceRoot: work, historyRoot: history },
        { items: bundleItems(held.index).map((item) => item.id), includeSecrets: true },
        LIMIT,
        async () => {},
    );
    await dropSpool(held.spool);
    return { indexRefused: held.index.refused, report };
};

test("a symlink out of the root, and the file written through it, are refused before anything lands", async () => {
    const { indexRefused, report } = await arrive(
        await crafted([
            { name: "workspace/x", linkname: outside },
            { name: "workspace/x/passwd", body: "root::0:0::/root:/bin/sh\n" },
            { name: "workspace/up", linkname: "../outside" },
            { name: "workspace/notes.md", body: "# kept\n" },
        ]),
    );
    expect(await readdir(outside)).toEqual([]);
    // Told in the plan, before the owner applies anything, and again in the report.
    expect(indexRefused).toEqual(["workspace/x", "workspace/x/passwd", "workspace/up"]);
    expect(report.refused).toEqual(["workspace/x", "workspace/x/passwd", "workspace/up"]);
    await expect(lstat(join(work, "x"))).rejects.toThrow(/ENOENT/);
    expect(await readFile(join(work, "notes.md"), "utf8")).toBe("# kept\n");
});

// Each link reads as inside on its own text; together they climb out, which only the path through the first shows.
test("a chain of links that each look inside is refused at the entry written through them", async () => {
    const { indexRefused } = await arrive(
        await crafted([
            { name: "workspace/d/s", linkname: ".." },
            { name: "workspace/x", linkname: "d/s/.." },
            { name: "workspace/x/outside/planted", body: "planted\n" },
        ]),
    );
    expect(indexRefused).toEqual(["workspace/x/outside/planted"]);
    expect(await readdir(outside)).toEqual([]);
});

// A link the bundle never declared, already on disk: only the apply pass can see it, and it reports it the same way.
test("a link already on disk is never written through", async () => {
    await symlink(outside, join(work, "pre"));
    const { indexRefused, report } = await arrive(await crafted([{ name: "workspace/pre/planted", body: "planted\n" }]));
    expect(indexRefused).toEqual([]);
    expect(report.refused).toEqual(["workspace/pre/planted"]);
    expect(await readdir(outside)).toEqual([]);
});

test("a file arriving where a dangling link stands replaces the link instead of creating its target", async () => {
    await symlink(join(outside, "created"), join(work, "dangling"));
    const { report } = await arrive(await crafted([{ name: "workspace/dangling", body: "mine\n" }]));
    expect(report.refused).toEqual([]);
    expect(await readdir(outside)).toEqual([]);
    expect((await lstat(join(work, "dangling"))).isFile()).toBe(true);
});

// Placement reads the member path every tar reader shares, so a name that climbs is refused in the plan, not only at
// apply, where the owner would never see it.
test("an entry whose name climbs out of its root is refused in the plan", async () => {
    const { indexRefused, report } = await arrive(await crafted([{ name: "workspace/../history/planted", body: "planted\n" }]));
    expect(indexRefused).toEqual(["workspace/../history/planted"]);
    expect(report.refused).toEqual(["workspace/../history/planted"]);
    expect(await readdir(history)).not.toContain("planted");
});
