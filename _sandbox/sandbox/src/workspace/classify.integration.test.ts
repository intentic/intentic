import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyWorkspace } from "./classify.js";
import { walkWorkspaceTree } from "./workspace-tree.js";

// Minimal byte signatures: enough for file-type to recognize the format at Stage 2.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\n");

describe("classifyWorkspace", () => {
    it("runs the cascade over a walked tree: repo markers, magic bytes, ext, text fallback, and inherits the walk's ignore filtering", async () => {
        const root = await mkdtemp(join(tmpdir(), "classify-"));

        // Stage 1: a repo dir, classified as one unit, contents not descended.
        await mkdir(join(root, "myrepo", "src"), { recursive: true });
        await writeFile(join(root, "myrepo", "package.json"), "{}");
        await writeFile(join(root, "myrepo", "src", "index.ts"), "export {};");

        // Stage 2: magic-byte types.
        await writeFile(join(root, "report.pdf"), PDF);
        await writeFile(join(root, "logo.png"), PNG);
        await writeFile(join(root, "bundle.zip"), ZIP);

        // Stage 3: extension map, and text-content fallback for an extension-less file.
        await writeFile(join(root, "notes.md"), "# notes");
        await writeFile(join(root, "READMEnoext"), "just some plain text, no extension");

        // Ignored junk must never be classified (the walk drops node_modules before we see it).
        await mkdir(join(root, "node_modules", "left-pad"), { recursive: true });
        await writeFile(join(root, "node_modules", "left-pad", "index.js"), "module.exports = 1;");

        const { classifications } = await classifyWorkspace(root, await walkWorkspaceTree(root));
        const bucket = Object.fromEntries(classifications.map((c) => [c.path, c.bucket]));

        expect(bucket["myrepo"]).toBe("repositories");
        expect(bucket["myrepo/src/index.ts"]).toBeUndefined(); // repo not descended
        expect(bucket["report.pdf"]).toBe("documents");
        expect(bucket["logo.png"]).toBe("media");
        expect(bucket["bundle.zip"]).toBe("archives");
        expect(bucket["notes.md"]).toBe("documents");
        expect(bucket["READMEnoext"]).toBe("documents");
        expect(classifications.some((c) => c.path.startsWith("node_modules"))).toBe(false);
    });

    it("skips the tree's grayed `ignored` entries, a .gitignore'd loose file is never classified", async () => {
        const root = await mkdtemp(join(tmpdir(), "classify-ignored-"));
        await writeFile(join(root, ".gitignore"), "*.log\n");
        await writeFile(join(root, "notes.md"), "# real doc");
        await writeFile(join(root, "debug.log"), "gitignored noise"); // grayed (ignored) in the tree → must not classify

        const { classifications } = await classifyWorkspace(root, await walkWorkspaceTree(root));
        const paths = classifications.map((c) => c.path);
        expect(paths).toContain("notes.md");
        expect(paths).not.toContain("debug.log");
    });
});
