import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { extensionDir } from "../capabilities/extension-dirs.js";
import type { Services } from "../composition.js";
import { opt } from "../opt.js";
import { testConfig } from "../testing.js";
import { readWorkspaceFile } from "../workspace/files/workspace-files.js";
import { devSummaryOf, readExtensionDev, worktreesRootOf, writeExtensionDev } from "./extension-dev.js";
import { devTargetOf, resolveDevPath, sourceCheckoutOf } from "./extension-dev-source.js";
import { extensionInventory, type InstalledExtension } from "./installed-extensions.js";

// Dev mode at the inventory: a pointer swaps an install's directory for a checkout only when the checkout is the same
// extension with the same powers and a built bundle, inside the workspace or a conversation's copy of it. Anything else
// leaves the pinned copy running and says why on the row.

const URL = "https://github.com/intentic/extension-maintenance.git";
const ID = "intentic-maintenance";

const manifest = (overrides: object = {}) => ({
    publisher: "intentic",
    name: "maintenance",
    version: "1.0.0",
    engines: { intentic: "^0.2.0" },
    entry: "dist/extension.js",
    permissions: { sandbox: ["GET /logs"] },
    ...overrides,
});

const writeExtension = async (dir: string, body: object, bundle?: string): Promise<void> => {
    await mkdir(join(dir, "dist"), { recursive: true });
    await writeFile(join(dir, "intentic-extension.json"), JSON.stringify(body));
    if (bundle !== undefined) {
        await writeFile(join(dir, "dist", "extension.js"), bundle);
    }
};

const git = (dir: string, ...args: string[]): void => {
    execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
};

// A git repo with one remote, so the source lookup has an address to match.
const repoAt = async (dir: string, remote: string, name = "origin"): Promise<void> => {
    await mkdir(dir, { recursive: true });
    git(dir, "init", "-q");
    git(dir, "remote", "add", name, remote);
};

// A workspace with a pinned install of intentic.maintenance, and a history root of its own for the worktrees.
const setup = async (config: Partial<{ path: string }> = {}) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ext-dev-")));
    const historyRoot = realpathSync(mkdtempSync(join(tmpdir(), "ext-dev-history-")));
    const pinned = extensionDir(root, ID);
    await writeExtension(config.path === undefined ? pinned : join(pinned, config.path), manifest(), "pinned");
    const capabilities: Capability[] = [{ id: ID, kind: "extension", config: { url: URL, ref: "a".repeat(40), ...config } }];
    const services = unstubbed<Services>("services", {
        workspace: unstubbed<Services["workspace"]>("workspace", { root }),
        files: unstubbed<Services["files"]>("files", { read: readWorkspaceFile }),
        capabilities: unstubbed<Services["capabilities"]>("capabilities", { list: async () => capabilities }),
        config: { ...testConfig, extensionsDir: "", historyRoot },
    });
    const installed = async (): Promise<InstalledExtension> => {
        const found = (await extensionInventory(services)).extensions.find((extension) => extension.id === ID);
        if (found === undefined) {
            throw new Error("the install is not enumerated");
        }
        return found;
    };
    const point = (path: string, conversation?: string) =>
        writeExtensionDev(root, ID, { path, ...opt("conversation", conversation), setAt: "2026-10-06T00:00:00.000Z" });
    return { root, historyRoot, pinned, installed, point };
};

test("a valid checkout becomes the install's directory and manifest, and the row says where it runs from", async () => {
    const { root, pinned, installed, point } = await setup();
    const checkout = join(root, "extensions", "maintenance");
    await writeExtension(checkout, manifest({ version: "1.1.0" }), "export const activate = () => {};");

    expect((await installed()).dir).toBe(pinned);
    await point(checkout);

    const extension = await installed();
    expect(extension).toMatchObject({ id: ID, source: "installed", dir: checkout, dev: { checkout, place: { path: "extensions/maintenance" } } });
    expect(extension.manifest.version).toBe("1.1.0");
    expect(extension.dev?.held).toBeUndefined();
    const summary = await devSummaryOf(extension);
    expect(summary).toEqual({ path: "extensions/maintenance", revision: expect.stringMatching(/^[0-9a-f]{12}$/) });
});

test("the row counts what the checkout has not committed, a rebuilt bundle included", async () => {
    const { root, installed, point } = await setup();
    const checkout = join(root, "extensions", "maintenance");
    await writeExtension(checkout, manifest(), "v1");
    git(checkout, "init", "-q");
    git(checkout, "add", "-A");
    git(checkout, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
    await point(checkout);
    expect((await devSummaryOf(await installed()))?.uncommitted).toBe(0);

    const before = (await devSummaryOf(await installed()))?.revision;
    await writeFile(join(checkout, "dist", "extension.js"), "v2");
    const after = await devSummaryOf(await installed());
    expect(after?.uncommitted).toBe(1);
    expect(after?.revision).not.toBe(before);
});

test("a checkout of another extension is held, and the pinned copy keeps running", async () => {
    const { root, pinned, installed, point } = await setup();
    const checkout = join(root, "extensions", "other");
    await writeExtension(checkout, manifest({ publisher: "acme", name: "other" }), "x");
    await point(checkout);

    const extension = await installed();
    expect(extension.dir).toBe(pinned);
    expect(extension.manifest.name).toBe("maintenance");
    expect(extension.dev?.held).toBe("extensions/other holds acme.other, not intentic.maintenance");
    expect(await devSummaryOf(extension)).toEqual({ path: "extensions/other", held: "extensions/other holds acme.other, not intentic.maintenance" });
});

test("a checkout declaring more powers is held, naming what it asks for beyond the pinned version", async () => {
    const { root, pinned, installed, point } = await setup();
    const checkout = join(root, "extensions", "maintenance");
    await writeExtension(checkout, manifest({ permissions: { sandbox: ["GET /logs", "POST /extensions/{id}/remove"] } }), "x");
    await point(checkout);

    const extension = await installed();
    expect(extension.dir).toBe(pinned);
    expect(extension.dev?.held).toContain("extensions/maintenance asks for more than the pinned version");
    expect(extension.dev?.held).toContain("POST /extensions/{id}/remove");
});

test("a checkout that is not built yet is held until its bundle exists", async () => {
    const { root, pinned, installed, point } = await setup();
    const checkout = join(root, "extensions", "maintenance");
    await writeExtension(checkout, manifest());
    await point(checkout);

    expect((await installed()).dir).toBe(pinned);
    expect((await installed()).dev?.held).toBe("extensions/maintenance is not built yet (dist/extension.js is missing): run its build there");

    await writeFile(join(checkout, "dist", "extension.js"), "built");
    expect((await installed()).dir).toBe(checkout);
});

test("a path outside the workspace, or into its own state, is never run from", async () => {
    const { pinned, installed, point } = await setup();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "ext-dev-outside-")));
    await writeExtension(outside, manifest(), "x");
    await point(outside);
    expect((await installed()).dir).toBe(pinned);
    expect((await installed()).dev?.held).toBe(`${outside} is outside the workspace`);

    // The pinned copy itself lives under .intentic/; pointing at it (or any state) is refused the same way.
    await point(pinned);
    expect((await installed()).dir).toBe(pinned);
    expect((await installed()).dev?.held).toContain("is inside .intentic/");

    await point("/nowhere/at/all");
    expect((await installed()).dev?.held).toBe("the checkout at /nowhere/at/all is gone");
});

test("a conversation's isolated copy of the workspace is a place to run from, and says whose it is", async () => {
    const { historyRoot, installed, point } = await setup();
    const checkout = join(worktreesRootOf(historyRoot), "conv-1", "extensions", "maintenance");
    await writeExtension(checkout, manifest(), "x");
    await point(checkout, "conv-1");

    const extension = await installed();
    expect(extension.dir).toBe(checkout);
    expect(await devSummaryOf(extension)).toMatchObject({ path: "extensions/maintenance", conversation: "conv-1" });
});

test("an install that lives in a subdirectory of its repository runs from the same subdirectory of the checkout", async () => {
    const { root, installed, point } = await setup({ path: "_extensions/maintenance" });
    const checkout = join(root, "monorepo");
    await writeExtension(join(checkout, "_extensions", "maintenance"), manifest(), "x");
    await point(checkout);

    const extension = await installed();
    expect(extension.dir).toBe(join(checkout, "_extensions", "maintenance"));
    expect((await devSummaryOf(extension))?.path).toBe("monorepo");
});

test("the source checkout is found by its remote, the calling conversation's copy first", async () => {
    const { root, historyRoot } = await setup();
    const roots = { root, historyRoot };
    await repoAt(join(root, "extensions", "unrelated"), "https://github.com/acme/unrelated.git");
    // Matched across the ssh and https spellings, with or without .git.
    await repoAt(join(root, "extensions", "maintenance"), "git@github.com:intentic/extension-maintenance");
    expect(await sourceCheckoutOf(roots, URL, undefined)).toEqual({
        absolute: join(root, "extensions", "maintenance"),
        path: "extensions/maintenance",
    });

    const own = join(worktreesRootOf(historyRoot), "conv-2", "extensions", "maintenance");
    await repoAt(own, URL);
    expect(await sourceCheckoutOf(roots, URL, "conv-2")).toEqual({ absolute: own, path: "extensions/maintenance", conversation: "conv-2" });
    // A conversation with no copy of its own reads the workspace's.
    expect((await sourceCheckoutOf(roots, URL, "conv-3"))?.path).toBe("extensions/maintenance");
    expect(await sourceCheckoutOf(roots, "https://github.com/acme/elsewhere.git", undefined)).toBeUndefined();
});

test("an origin match outranks a repository that only names the address as another remote", async () => {
    const { root, historyRoot } = await setup();
    await repoAt(join(root, "extensions", "fork"), URL, "upstream");
    await repoAt(join(root, "work", "maintenance"), URL);
    expect((await sourceCheckoutOf({ root, historyRoot }, URL, undefined))?.path).toBe("work/maintenance");
});

test("a path from an isolated conversation reads against its own copy of the workspace", async () => {
    const { root, historyRoot } = await setup();
    const roots = { root, historyRoot };
    const own = join(worktreesRootOf(historyRoot), "conv-4");
    await mkdir(join(own, "extensions", "maintenance"), { recursive: true });
    await mkdir(join(root, "extensions", "shared-only"), { recursive: true });

    expect(await resolveDevPath(roots, join(root, "extensions", "maintenance/"), "conv-4", undefined)).toBe(join(own, "extensions", "maintenance"));
    expect(await resolveDevPath(roots, "extensions/maintenance", "conv-4", undefined)).toBe(join(own, "extensions", "maintenance"));
    // Its copy does not hold this one, so the workspace's is meant.
    expect(await resolveDevPath(roots, join(root, "extensions", "shared-only"), "conv-4", undefined)).toBe(join(root, "extensions", "shared-only"));
    expect(await resolveDevPath(roots, "extensions/maintenance", undefined, undefined)).toBe(join(root, "extensions", "maintenance"));
    // Named by the extension's own directory inside a larger repository: the pointer names the repository.
    expect(await resolveDevPath(roots, join(root, "mono", "_extensions", "maintenance"), undefined, "_extensions/maintenance")).toBe(
        join(root, "mono"),
    );
});

test("a verb names an install by its connection id, manifest id or short name, and refuses what already runs from source", async () => {
    const { installed } = await setup();
    const extension = await installed();
    const baked = { ...extension, id: "intentic.discord", source: "builtin" as const, manifest: { ...extension.manifest, name: "discord" } };
    for (const name of [ID, "intentic.maintenance", "maintenance"]) {
        expect(devTargetOf([extension, baked], name)).toBe(extension);
    }
    expect(devTargetOf([extension, baked], "discord")).toEqual({ refused: expect.stringContaining("built into the sandbox image") });
    expect(devTargetOf([extension, baked], "nothing")).toEqual({ refused: 'no installed extension is called "nothing"' });
});

test("the pointer file reads empty when absent and keeps one entry per install", async () => {
    const { root, point } = await setup();
    expect(await readExtensionDev(root)).toEqual({});
    await point("/somewhere");
    expect(JSON.parse(await readFile(join(root, ".intentic", "local", "extension-dev.json"), "utf8"))).toEqual({
        [ID]: { path: "/somewhere", setAt: "2026-10-06T00:00:00.000Z" },
    });
});
