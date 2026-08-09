import { cpSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { repoRoot } from "@intentic/constants/node";
import type { ExtensionManifest } from "@intentic/extension-manifest";
import { expect, test } from "vitest";
import { extensionRuntimeAbsent } from "./extension-readiness.js";
import type { InstalledExtension } from "./installed-extensions.js";

/* The image-split absence probe, against the REAL messaging manifests: the core image bakes exactly
 * /opt/extensions/<name>/intentic-extension.json (see the Dockerfile's manifest-only COPYs), so a fixture that
 * copies just the manifest into an empty dir IS the core image's layout — if a gateway's manifest ever stops
 * promising any on-disk path, this is the test that says the probe went blind for it. */

const EXTENSIONS_SRC = join(repoRoot(import.meta.url), "_extensions");
const GATEWAYS = ["discord", "imap", "slack", "telegram", "whatsapp"];

const manifestOf = async (name: string): Promise<ExtensionManifest> =>
    JSON.parse(await readFile(join(EXTENSIONS_SRC, name, "intentic-extension.json"), "utf8")) as ExtensionManifest;

const baked = (dir: string, manifest: ExtensionManifest): InstalledExtension => ({
    id: "test.extension",
    dir,
    manifest,
    source: "builtin",
    enabled: true,
});

test("a manifest-only gateway dir — the core image's layout — reads as runtime-absent, for every gateway", async () => {
    for (const name of GATEWAYS) {
        const dir = mkdtempSync(join(tmpdir(), `readiness-${name}-`));
        cpSync(join(EXTENSIONS_SRC, name, "intentic-extension.json"), join(dir, "intentic-extension.json"));
        expect(await extensionRuntimeAbsent(baked(dir, await manifestOf(name))), `${name} must read as absent`).toBe(true);
    }
});

test("a dir carrying everything its manifest promises reads as present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "readiness-full-"));
    mkdirSync(join(dir, "skills"), { recursive: true });
    const manifest = {
        name: "full",
        publisher: "test",
        version: "0.0.1",
        contributes: { capabilities: [{ kind: "cli", provider: "full", title: "Full", skill: "skills/SKILL.md" }] },
    } as unknown as ExtensionManifest;
    cpSync(join(EXTENSIONS_SRC, "imap", "skills"), join(dir, "skills"), { recursive: true });
    const withSkill = {
        ...manifest,
        contributes: { capabilities: [{ kind: "cli", provider: "x", title: "X", skill: "skills/imap/SKILL.md" }] },
    } as unknown as ExtensionManifest;
    expect(await extensionRuntimeAbsent(baked(dir, withSkill))).toBe(false);
});

// Only an image-baked extension can be complete, correct and still absent — a checkout or workspace dir with
// missing files is a rotted install or work in progress, which pathsCheck reports in the author's terms.
test("non-builtin sources never read as runtime-absent, whatever is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "readiness-src-"));
    const manifest = await manifestOf("discord");
    for (const source of ["installed", "workspace"] as const) {
        expect(await extensionRuntimeAbsent({ ...baked(dir, manifest), source })).toBe(false);
    }
});
