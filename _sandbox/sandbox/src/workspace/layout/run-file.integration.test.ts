import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import type { TemplateManifest } from "@intentic/scaffold";
import { RUN_TARGETS_FILE } from "@intentic/sandbox-contract/schemas/run-targets";
import { buildAppSpec, repoApps } from "./app-previews.js";
import { readRunFile, runFileApps, sandboxTargetsAt } from "./run-file.js";

// One .intentic/run.json says what a repository runs and where: a `command` runs in the sandbox, served as one of the
// repository's apps; an `artifact` is carried to a computer; a target may have both.

const repo = (targets: unknown, files: Record<string, string> = {}): string => {
    const dir = mkdtempSync(join(tmpdir(), "run-file-"));
    mkdirSync(join(dir, STATE_DIR), { recursive: true });
    writeFileSync(join(dir, RUN_TARGETS_FILE), JSON.stringify({ targets }));
    for (const [path, text] of Object.entries(files)) {
        writeFileSync(join(dir, path), text);
    }
    return dir;
};

const MANIFEST: TemplateManifest = { scope: "@shop/", shell: [], shared: [], templates: {} };

test("the targets with a command run in the sandbox, as apps run from the repository's root", () => {
    const dir = repo([
        { name: "demo", command: "pnpm -C site dev", env: { API_URL: "{previewUrl:api}" } },
        { name: "desktop", artifact: "out/app.exe", device: "rog" },
        { name: "game", command: "cargo run", artifact: "target/game.exe" },
    ]);
    expect(sandboxTargetsAt(dir).map((target) => target.name)).toEqual(["demo", "game"]);
    const [demo] = runFileApps(dir);
    expect(demo).toMatchObject({ app: "demo", command: "pnpm -C site dev" });
    const spec = buildAppSpec({ repo: "shop", repoDir: dir, pkg: "", app: "demo", preview: demo!.preview, zone: "z.dev", sandboxId: "abc" });
    // No package.json: nothing for pnpm to install first.
    expect(spec.command).toBe("pnpm -C site dev");
    expect(spec.cwd).toBe(dir);
    expect(spec.env["API_URL"]).toBe("https://preview-shop--api-abc.z.dev");
});

test("a Node repository installs before its sandbox target runs, and the run file wins a name _apps/ also uses", () => {
    const dir = repo([{ name: "web", command: "pnpm dev" }], { "package.json": "{}" });
    const [web] = repoApps(dir, MANIFEST, runFileApps(dir));
    expect(web?.command).toBe("pnpm dev");
    expect(buildAppSpec({ repo: "shop", repoDir: dir, pkg: "", app: "web", preview: web!.preview, zone: undefined, sandboxId: undefined }).command).toBe(
        "test -d node_modules || pnpm install && pnpm dev",
    );
});

test("a sandbox target's name is its preview address, and every target runs somewhere", async () => {
    const root = mkdtempSync(join(tmpdir(), "run-file-root-"));
    const named = repo([{ name: "Demo.v2", command: "pnpm dev" }]);
    const nowhere = repo([{ name: "idle" }]);
    mkdirSync(join(root, "named"));
    mkdirSync(join(root, "nowhere"));
    writeFileSync(join(root, "named", "x"), "");
    expect((await readRunFile(named, "root"))?.error).toContain("lowercase letters, digits and dashes");
    expect((await readRunFile(nowhere, "root"))?.error).toContain(`a target needs a`);
    // A broken file declares nothing runnable; the dialog says what is wrong with it.
    expect(sandboxTargetsAt(named)).toEqual([]);
    expect(sandboxTargetsAt(join(root, "named", "x"))).toEqual([]);
    expect(sandboxTargetsAt(root)).toEqual([]);
});
