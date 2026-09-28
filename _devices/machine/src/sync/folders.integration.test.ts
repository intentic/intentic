import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pairing } from "./config.js";
import { canonicalFolder, overlappingPairing } from "./folders.js";

// Real folders and links in a temp tree: the guard is only as good as its reading of the filesystem, since two
// spellings of one folder (a link, a folder not made yet) are exactly what a comparison of strings would miss.
let root = "";

beforeEach(async () => {
    // realpath: the temp dir itself can sit behind a link (macOS /var → /private/var), which is the case under test.
    root = await realpath(await mkdtemp(join(tmpdir(), "sync-folders-")));
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

const paired = (sandboxId: string, localDir: string): Pairing & { readonly localDir: string } => ({
    sandboxUrl: `https://${sandboxId}.example.dev/`,
    sandboxId,
    mode: "sync",
    localDir,
});
const portsOnly = (sandboxId: string): Pairing => ({ sandboxUrl: `https://${sandboxId}.example.dev/`, sandboxId, mode: "mirror" });

describe("canonicalFolder", () => {
    it("follows a link to the folder it names", async () => {
        await mkdir(join(root, "code", "app"), { recursive: true });
        await symlink(join(root, "code"), join(root, "link"));

        expect(await canonicalFolder(join(root, "link", "app"))).toBe(join(root, "code", "app"));
    });

    it("resolves a folder that does not exist yet through its nearest existing parent", async () => {
        await mkdir(join(root, "code"), { recursive: true });
        await symlink(join(root, "code"), join(root, "link"));

        expect(await canonicalFolder(join(root, "link", "new", "app"))).toBe(join(root, "code", "new", "app"));
    });
});

describe("overlappingPairing", () => {
    it("finds another sandbox's folder reached through a link", async () => {
        await mkdir(join(root, "code", "app"), { recursive: true });
        await symlink(join(root, "code"), join(root, "link"));
        const other = paired("sandbox-other", join(root, "link", "app"));

        expect(await overlappingPairing(join(root, "code", "app", "web"), "sandbox-new", [other], "linux")).toEqual(other);
    });

    it("finds a folder that would hold another sandbox's", async () => {
        const other = paired("sandbox-other", join(root, "intentic", "work"));

        expect(await overlappingPairing(root, "sandbox-new", [other], "linux")).toEqual(other);
    });

    it("lets the same sandbox be set up again in its own folder, and ignores ports-only pairings and siblings", async () => {
        const own = paired("sandbox-new", join(root, "app"));
        const ports = portsOnly("sandbox-ports");
        const sibling = paired("sandbox-sibling", join(root, "app-2"));

        expect(await overlappingPairing(join(root, "app"), "sandbox-new", [own, ports, sibling], "linux")).toBeUndefined();
    });
});
