import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability } from "@intentic/sandbox-contract";
import { installedCopyDirtyPaths, installedCopyNote, installedCopyOf, installedCopyReviewer } from "./installed-copy.js";

// A real workspace on disk: an install is a git clone under .intentic/local/extensions/<capability id>, its source is a
// nested repo whose origin is the install's url, and a baked extension sits under the image's extensions dir. The note
// reads all three off the filesystem and git, so the suite builds them rather than describing them.

const URL = "https://github.com/acme/extension-widgets.git";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const MANIFEST = JSON.stringify({ publisher: "acme", name: "widgets", version: "1.0.0", engines: { intentic: ">=0.0.0" } });

const git = (cwd: string, ...args: string[]): void => {
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, stdio: "ignore" });
};

const repoAt = (dir: string, remote?: string): void => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "intentic-extension.json"), MANIFEST);
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "dist", "extension.js"), "export default 1;\n");
    git(dir, "init", "-q");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "start");
    if (remote !== undefined) {
        git(dir, "remote", "add", "origin", remote);
    }
};

const root = mkdtempSync(join(tmpdir(), "installed-copy-"));
const baked = mkdtempSync(join(tmpdir(), "installed-copy-baked-"));
const install = join(root, ".intentic", "local", "extensions", "acme-widgets");
repoAt(install, URL);
const capabilities: Capability[] = [{ id: "acme-widgets", kind: "extension", config: { url: URL, ref: SHA } } as Capability];
afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(baked, { recursive: true, force: true });
});

const reviewerFor = () =>
    installedCopyReviewer({
        root,
        bakedRoot: () => baked,
        capabilities: async () => capabilities,
        relative: (file) => (file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file.startsWith("/") ? undefined : file),
    });

describe(`which running copy a written path is in`, () => {
    test(`an install, by relative name, absolute name, the main mount, or an update's side copy`, () => {
        expect(installedCopyOf(".intentic/local/extensions/acme-widgets/src/View.vue", undefined)).toEqual({
            kind: "installed",
            dir: "acme-widgets",
        });
        expect(installedCopyOf("/work/.intentic/local/extensions/acme-widgets/dist/extension.js", undefined)).toEqual({
            kind: "installed",
            dir: "acme-widgets",
        });
        expect(installedCopyOf("/mnt/intentic-main/.intentic/local/extensions/acme-widgets/a.ts", undefined)).toEqual({
            kind: "installed",
            dir: "acme-widgets",
        });
        expect(installedCopyOf(".intentic/local/extensions/.acme-widgets.previous/a.ts", undefined)).toEqual({
            kind: "installed",
            dir: "acme-widgets",
        });
    });

    test(`a baked extension under the image's extensions dir`, () => {
        expect(installedCopyOf("/opt/extensions/viewers/src/a.ts", "/opt/extensions")).toEqual({ kind: "baked", name: "viewers" });
        expect(installedCopyOf("/opt/extensions/viewers/src/a.ts", undefined)).toBeUndefined();
    });

    test(`source checkouts, other state and ordinary files are none of them`, () => {
        expect(installedCopyOf("extensions/widgets/src/View.vue", "/opt/extensions")).toBeUndefined();
        expect(installedCopyOf(".intentic/config/extension-enablement.json", "/opt/extensions")).toBeUndefined();
        expect(installedCopyOf(".intentic/local/extensions/acme-widgets", "/opt/extensions")).toBeUndefined();
    });
});

describe(`the note on an edit to an install`, () => {
    test(`names the install, its pin and url, and sends the change to the workspace's checkout of the source`, async () => {
        repoAt(join(root, "extensions", "widgets"), "git@github.com:acme/extension-widgets");
        const note = await reviewerFor()(join(install, "src", "View.vue"), "this edit");
        expect(note).toContain("This edit changed `.intentic/local/extensions/acme-widgets/src/View.vue`");
        expect(note).toContain("the installed copy of acme.widgets");
        expect(note).toContain(`the sandbox's clone of ${URL} at 0123456`);
        expect(note).toContain("Change its source instead: `extensions/widgets`");
        expect(note).toContain("`extension dev widgets`");
        expect(note).toContain("`git -C .intentic/local/extensions/acme-widgets checkout -- <files>`");
        rmSync(join(root, "extensions"), { recursive: true, force: true });
    });

    test(`is said once per install per turn`, async () => {
        const reviewer = reviewerFor();
        expect(await reviewer(join(install, "a.ts"), "this edit")).toContain("the installed copy of acme.widgets");
        expect(await reviewer(join(install, "b.ts"), "this command")).toBeUndefined();
        expect(await reviewerFor()(join(install, "b.ts"), "this command")).toContain("This command changed");
    });

    test(`without a checkout of the source, it says a clone made in the conversation would not land`, async () => {
        const note = await reviewerFor()(".intentic/local/extensions/acme-widgets/src/View.vue", "this command");
        expect(note).toContain("No checkout of it is in this workspace");
        expect(note).toContain("does not land with your work");
        expect(note).not.toContain("extension dev");
    });

    test(`an install with no capability entry still gets the note, by its directory name`, async () => {
        const note = await reviewerFor()(".intentic/local/extensions/acme-gadgets/src/a.ts", "this edit");
        expect(note).toContain("the installed copy of acme-gadgets");
    });

    test(`an ordinary source file says nothing`, async () => {
        expect(await reviewerFor()("extensions/widgets/src/View.vue", "this edit")).toBeUndefined();
    });
});

describe(`the note on an edit to a baked extension`, () => {
    test(`points at the product's own source when the workspace has it`, async () => {
        mkdirSync(join(baked, "viewers"), { recursive: true });
        writeFileSync(
            join(baked, "viewers", "intentic-extension.json"),
            JSON.stringify({ ...JSON.parse(MANIFEST), publisher: "intentic", name: "viewers" }),
        );
        repoAt(join(root, "intentic"));
        mkdirSync(join(root, "intentic", "_extensions", "viewers"), { recursive: true });
        writeFileSync(join(root, "intentic", "_extensions", "viewers", "intentic-extension.json"), MANIFEST);
        const note = await reviewerFor()(join(baked, "viewers", "src", "a.ts"), "this edit");
        expect(note).toContain("intentic.viewers as baked into the sandbox image");
        expect(note).toContain("Change its source instead, `intentic/_extensions/viewers`");
        rmSync(join(root, "intentic"), { recursive: true, force: true });
    });

    test(`and says when it does not`, () => {
        expect(
            installedCopyNote(
                "/opt/extensions/viewers/a.ts",
                "this edit",
                { kind: "baked", name: "viewers" },
                { id: "intentic.viewers", short: "viewers" },
                "/opt/extensions",
            ),
        ).toContain("which this workspace has no checkout of");
    });
});

describe(`shell writes into an install`, () => {
    test(`are listed workspace-relative, so the shell edit tracker hands them to the note`, async () => {
        writeFileSync(join(install, "dist", "extension.js"), "export default 2;\n");
        expect(await installedCopyDirtyPaths(root)()).toEqual([".intentic/local/extensions/acme-widgets/dist/extension.js"]);
        git(install, "checkout", "--", "dist/extension.js");
        expect(await installedCopyDirtyPaths(root)()).toEqual([]);
    });

    test(`a workspace with no installs lists nothing`, async () => {
        expect(await installedCopyDirtyPaths(join(root, "nowhere"))()).toEqual([]);
    });
});
