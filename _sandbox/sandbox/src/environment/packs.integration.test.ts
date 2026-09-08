import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot as findRepoRoot } from "@intentic/constants/node";
import { expect, test } from "vitest";
import { bakedPackHash, listPacks, packFragment, readPack } from "./packs.js";

const repoRoot = findRepoRoot(import.meta.url);
const sandboxRoot = join(repoRoot, "_sandbox/sandbox");

test("profiles name real packs, and placement/overlayability inference matches each pack's content", async () => {
    const packs = await listPacks();
    const byName = new Map(packs.map((pack) => [pack.name, pack]));
    const profiles = JSON.parse(readFileSync(join(sandboxRoot, "image-packs/profiles.json"), "utf8")).profiles as Record<string, string[]>;
    expect(profiles["core"]).toEqual([]);
    for (const name of profiles["standard"] ?? []) {
        expect(byName.has(name), `standard profile names unknown pack "${name}"`).toBe(true);
    }
    for (const name of ["docker", "browser", "codex", "cursor", "opencode", "translator"]) {
        expect(byName.get(name)?.overlayable, `${name} must be overlay-installable`).toBe(true);
        expect(byName.get(name)?.postTrees, `${name} must splice above the tree COPYs`).toBe(false);
    }
    // cursor's licence bars redistribution; only Connect installs it, not any profile (provider-packs.ts).
    for (const profile of Object.values(profiles)) {
        expect(profile, "no profile may bake the cursor pack: its licence grants no redistribution").not.toContain("cursor");
    }
    for (const name of ["semantic", "messaging"]) {
        expect(byName.get(name)?.overlayable, `${name} is bake-only (COPYs from the trees context)`).toBe(false);
        expect(byName.get(name)?.postTrees, `${name} must splice below the tree COPYs`).toBe(true);
    }
    // Privileges belong to capability handlers, not packs; rebuild executors grep for the runtime-directive token.
    for (const pack of packs) {
        expect(pack.content.includes("intentic:" + "runtime"), `${pack.name} must not carry the runtime-directive token`).toBe(false);
    }
});

test("packFragment answers by base stamp: absent → content, current → nothing, stale → content", async () => {
    const stamps = mkdtempSync(join(tmpdir(), "packs-"));
    const browser = (await readPack("browser"))!;
    expect(await packFragment("browser", stamps)).toBe(browser.content);
    writeFileSync(join(stamps, "browser"), browser.hash);
    expect(await packFragment("browser", stamps)).toBeUndefined();
    writeFileSync(join(stamps, "browser"), "0".repeat(64));
    expect(await packFragment("browser", stamps)).toBe(browser.content);
    expect(await bakedPackHash("browser", stamps)).toBe("0".repeat(64));
});

// Unknown pack names return undefined instead of throwing: a capability referencing a dropped pack must degrade, not
// crash.
test("bake-only and unknown packs compose no overlay fragment", async () => {
    const stamps = mkdtempSync(join(tmpdir(), "packs-"));
    expect(await packFragment("messaging", stamps)).toBeUndefined();
    expect(await packFragment("semantic", stamps)).toBeUndefined();
    expect(await packFragment("no-such-pack", stamps)).toBeUndefined();
});

// An architecture-naming pack must ask which one it's building for (dpkg --print-architecture / uname -m); the same
// fragment composes into amd64 and arm64 alike. llamacpp-cuda is exempt: amd64-only by construction, overlay-only.
test("a pack naming an architecture branches on the one it is building for", async () => {
    const NAMES_AN_ARCH = /x86_64|aarch64|[-_](x64|amd64|arm64)\b/i;
    const ASKS_WHICH = /dpkg --print-architecture|uname -m/;
    for (const pack of await listPacks()) {
        if (pack.name === "llamacpp-cuda" || !NAMES_AN_ARCH.test(pack.content)) {
            continue;
        }
        expect(ASKS_WHICH.test(pack.content), `${pack.name} names an architecture but never asks which one it is building for`).toBe(true);
    }
});

// Pin-lockstep contracts each pack states in its ponytail comment; a bump on one side without the other fails here, not
// as a runtime skew.
//   browser : the packed playwright version matches the daemon's own.
//   codex : the packed CLI matches @openai/codex-sdk's exact dependency.
//   opencode: the packed CLI matches @opencode-ai/sdk.
test("pack pins are in lockstep with the daemon's own dependency versions", async () => {
    const pin = (content: string, pattern: RegExp): string => {
        const match = pattern.exec(content);
        expect(match?.[1], `no pin matching ${String(pattern)}`).toEqual(expect.any(String));
        return match![1]!;
    };
    const version = (pkg: string): string => JSON.parse(readFileSync(join(sandboxRoot, "node_modules", pkg, "package.json"), "utf8")).version;
    const browser = (await readPack("browser"))!;
    expect(pin(browser.content, /playwright@(\S+) install/)).toBe(version("playwright"));
    const codex = (await readPack("codex"))!;
    const sdkDeps = JSON.parse(readFileSync(join(sandboxRoot, "node_modules/@openai/codex-sdk/package.json"), "utf8")).dependencies;
    expect(pin(codex.content, /@openai\/codex@(\S+) /)).toBe(sdkDeps["@openai/codex"]);
    const opencode = (await readPack("opencode"))!;
    expect(pin(opencode.content, /opencode-ai@(\S+) /)).toBe(version("@opencode-ai/sdk"));
    // cursor: the packed module must match the daemon's compiled-against version; it's imported, not just invoked.
    const cursor = (await readPack("cursor"))!;
    expect(pin(cursor.content, /@cursor\/sdk@(\S+) /)).toBe(version("@cursor/sdk"));
});

// Complements the pin check above with what a CLI on this machine actually reports. Absent is not a failure (dev
// checkouts have no packs); a present CLI reporting the wrong version is a skew.
test("a provider CLI present on this machine reports the version its pack pins", async () => {
    const pinOf = async (pack: string, pattern: RegExp): Promise<string> => {
        const match = pattern.exec((await readPack(pack))!.content);
        expect(match?.[1], `no pin matching ${String(pattern)} in the ${pack} pack`).toEqual(expect.any(String));
        return match![1]!;
    };
    // Compare only the version digits: codex prints `codex-cli 0.147.0`, opencode a bare number, formats can change.
    const reported = (binary: string): string | undefined => {
        try {
            const output = execFileSync(binary, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000 });
            return /(\d+\.\d+\.\d+)/.exec(output)?.[1];
        } catch {
            // Not installed here, or not answering: nothing to compare.
            return undefined;
        }
    };

    const codexVersion = reported("codex");
    if (codexVersion !== undefined) {
        expect(codexVersion, "the codex on PATH is not the version image-packs/codex.Dockerfile pins").toBe(await pinOf("codex", /@openai\/codex@(\S+) /));
    }

    const opencodeVersion = reported("opencode");
    if (opencodeVersion !== undefined) {
        expect(opencodeVersion, "the opencode on PATH is not the version image-packs/opencode.Dockerfile pins").toBe(
            await pinOf("opencode", /opencode-ai@(\S+) /),
        );
    }

    // @cursor/sdk is a module the daemon imports, not a binary, read from where it resolves (cursor-sdk.ts). This skew
    // has no symptom until a turn is already running.
    const cursorDir = process.env["INTENTIC_CURSOR_SDK_DIR"] ?? "/opt/cursor-sdk";
    const cursorManifest = join(cursorDir, "node_modules/@cursor/sdk/package.json");
    if (existsSync(cursorManifest)) {
        expect(JSON.parse(readFileSync(cursorManifest, "utf8")).version, `the @cursor/sdk in ${cursorDir} is not the version image-packs/cursor.Dockerfile pins`).toBe(
            await pinOf("cursor", /@cursor\/sdk@(\S+) /),
        );
    }
});

// compose-image-dockerfile.mjs and this module implement one stamp-hash protocol; a mismatch reads baked images as
// unbaked. Also pins placement: pre-trees packs splice above the daemon tree COPY, post-trees below it.
test("compose-image-dockerfile.mjs stamps the hashes this module computes, in the right halves", async () => {
    const composed = execFileSync("node", ["_tools/scripts/image/compose-image-dockerfile.mjs", "standard"], { cwd: repoRoot, encoding: "utf8" });
    // llamacpp-cuda is overlay-only and must never be stamped, or a GPU rebuild reads as already baked.
    const profiles = JSON.parse(readFileSync(join(sandboxRoot, "image-packs/profiles.json"), "utf8")).profiles as Record<string, string[]>;
    const standard = new Set(profiles["standard"] ?? []);
    for (const pack of await listPacks()) {
        if (!standard.has(pack.name)) {
            expect(composed, `${pack.name} is not in the standard profile and must not be stamped`).not.toContain(`> /opt/packs/${pack.name}`);
            continue;
        }
        expect(composed).toContain(`> /opt/packs/${pack.name}`);
        expect(composed, `stamp for ${pack.name} must be its content hash`).toContain(`'${pack.hash}' > /opt/packs/${pack.name}`);
    }
    const treesCopy = composed.indexOf("COPY --from=trees sandbox /opt/sandbox");
    expect(treesCopy).toBeGreaterThan(-1);
    expect(composed.indexOf("# ---- pack: docker ----")).toBeLessThan(treesCopy);
    expect(composed.indexOf("# ---- pack: browser ----")).toBeLessThan(treesCopy);
    expect(composed.indexOf("# ---- pack: messaging ----")).toBeGreaterThan(treesCopy);
    expect(composed.indexOf("# ---- pack: semantic ----")).toBeGreaterThan(treesCopy);
    // The core profile is the Dockerfile unmodified: the minimal image is not a variant.
    const core = execFileSync("node", ["_tools/scripts/image/compose-image-dockerfile.mjs", "core"], { cwd: repoRoot, encoding: "utf8" });
    expect(core).toBe(readFileSync(join(sandboxRoot, "Dockerfile"), "utf8"));
});
