import { mkdtemp, mkdir, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { persistCodexImageArtifact } from "./codex-image-artifacts.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl5sAAAAASUVORK5CYII=", "base64");
const roots: string[] = [];

const fixture = async () => {
    const root = await mkdtemp(join(tmpdir(), "intentic-codex-image-"));
    roots.push(root);
    const workspaceRoot = join(root, "workspace");
    const codexHome = join(root, "codex");
    await Promise.all([mkdir(workspaceRoot), mkdir(join(codexHome, "generated_images"), { recursive: true })]);
    return { root, workspaceRoot, codexHome };
};

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("decodes a generated PNG into a durable workspace-relative artifact", async () => {
    const { workspaceRoot, codexHome } = await fixture();
    const path = await persistCodexImageArtifact({
        workspaceRoot,
        codexHome,
        image: { id: "ig/../../crocodile", result: PNG.toString("base64") },
    });

    expect(path).toBe(".intentic/records/artifacts/imagegen/ig_______crocodile.png");
    expect(await readFile(join(workspaceRoot, path))).toEqual(PNG);
});

test("copies a regular PNG from Codex's generated_images tree without removing the original", async () => {
    const { workspaceRoot, codexHome } = await fixture();
    const source = join(codexHome, "generated_images", "thr-1", "ig-1.png");
    await mkdir(join(codexHome, "generated_images", "thr-1"));
    await writeFile(source, PNG);

    const path = await persistCodexImageArtifact({ workspaceRoot, codexHome, image: { id: "ig-1", result: "", saved_path: source } });

    expect(path).toBe(".intentic/records/artifacts/imagegen/ig-1.png");
    expect(await readFile(join(workspaceRoot, path))).toEqual(PNG);
    expect(await readFile(source)).toEqual(PNG);
});

test("rejects saved paths outside generated_images and symbolic-link sources or destinations", async () => {
    const { root, workspaceRoot, codexHome } = await fixture();
    const outside = join(root, "outside.png");
    await writeFile(outside, PNG);
    await expect(persistCodexImageArtifact({ workspaceRoot, codexHome, image: { id: "outside", result: "", saved_path: outside } })).rejects.toThrow(
        "outside CODEX_HOME/generated_images",
    );

    const link = join(codexHome, "generated_images", "linked.png");
    await symlink(outside, link);
    await expect(persistCodexImageArtifact({ workspaceRoot, codexHome, image: { id: "linked", result: "", saved_path: link } })).rejects.toThrow(
        "must not be a symbolic link",
    );

    const outputDir = join(workspaceRoot, ".intentic", "records", "artifacts", "imagegen");
    await mkdir(outputDir, { recursive: true });
    const destination = join(root, "destination.png");
    await writeFile(destination, Buffer.from("unchanged"));
    await symlink(destination, join(outputDir, "redirected.png"));
    await expect(
        persistCodexImageArtifact({ workspaceRoot, codexHome, image: { id: "redirected", result: PNG.toString("base64") } }),
    ).rejects.toThrow();
    expect(await readFile(destination, "utf8")).toBe("unchanged");
});

test("rejects malformed base64, non-PNG content, and artifacts over 32 MiB", async () => {
    const { workspaceRoot, codexHome } = await fixture();
    await expect(persistCodexImageArtifact({ workspaceRoot, codexHome, image: { id: "bad", result: "%%%" } })).rejects.toThrow("not valid base64");
    await expect(
        persistCodexImageArtifact({ workspaceRoot, codexHome, image: { id: "text", result: Buffer.from("hello").toString("base64") } }),
    ).rejects.toThrow("not a PNG");

    const oversized = join(codexHome, "generated_images", "large.png");
    await writeFile(oversized, PNG);
    await truncate(oversized, 32 * 1024 * 1024 + 1);
    await expect(persistCodexImageArtifact({ workspaceRoot, codexHome, image: { id: "large", result: "", saved_path: oversized } })).rejects.toThrow(
        "exceeds 32 MiB",
    );
});

test("rejects an artifacts directory that resolves outside the workspace", async () => {
    const { root, workspaceRoot, codexHome } = await fixture();
    const outside = join(root, "outside-state");
    await mkdir(join(outside, "artifacts", "imagegen"), { recursive: true });
    await symlink(outside, join(workspaceRoot, ".intentic"));

    await expect(persistCodexImageArtifact({ workspaceRoot, codexHome, image: { id: "escaped", result: PNG.toString("base64") } })).rejects.toThrow(
        "output directory is outside the workspace",
    );
});
