import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot as findRepoRoot } from "@intentic/constants/node";
import { expect, test } from "vitest";
import { bakedPackHash, listPacks, packFragment, readPack } from "./packs.js";

const repoRoot = findRepoRoot(import.meta.url);
const sandboxRoot = join(repoRoot, "_sandbox/sandbox");

// What the mechanism trusts about the shipped pack set: every profile name resolves, and the two
// content-inferred properties land exactly where the image layout needs them: a wrong inference either
// splices a tree-dependent pack above the trees or offers a COPY pack to an overlay that cannot build it.
test("profiles name real packs, and placement/overlayability inference matches each pack's content", async () => {
    const packs = await listPacks();
    const byName = new Map(packs.map((pack) => [pack.name, pack]));
    const profiles = JSON.parse(readFileSync(join(sandboxRoot, "packs/profiles.json"), "utf8")).profiles as Record<string, string[]>;
    expect(profiles["core"]).toEqual([]);
    for (const name of profiles["standard"] ?? []) {
        expect(byName.has(name), `standard profile names unknown pack "${name}"`).toBe(true);
    }
    for (const name of ["docker", "browser", "codex", "opencode", "translator"]) {
        expect(byName.get(name)?.overlayable, `${name} must be overlay-installable`).toBe(true);
        expect(byName.get(name)?.postTrees, `${name} must splice above the tree COPYs`).toBe(false);
    }
    for (const name of ["semantic", "messaging"]) {
        expect(byName.get(name)?.overlayable, `${name} is bake-only (COPYs from the trees context)`).toBe(false);
        expect(byName.get(name)?.postTrees, `${name} must splice below the tree COPYs`).toBe(true);
    }
    // Privileges belong to capability HANDLERS, never packs, and the rebuild executors grep for the runtime
    // directive token comments included, so a pack must not contain it even in prose.
    for (const pack of packs) {
        expect(pack.content.includes("intentic:" + "runtime"), `${pack.name} must not carry the runtime-directive token`).toBe(false);
    }
});

// The stamp protocol end to end: no stamp → the fragment rides the overlay (a core image); the exact hash
// stamped → nothing to compose (the standard image, and the reason a rebuild converges instead of
// re-prompting); a stale hash → the newer pack rides the overlay again (the upgrade path).
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

// Bake-only packs never reach an overlay whatever the stamps say, and unknown names resolve to nothing
// rather than a throw: a capability referencing a pack that a newer daemon dropped must degrade, not crash.
test("bake-only and unknown packs compose no overlay fragment", async () => {
    const stamps = mkdtempSync(join(tmpdir(), "packs-"));
    expect(await packFragment("messaging", stamps)).toBeUndefined();
    expect(await packFragment("semantic", stamps)).toBeUndefined();
    expect(await packFragment("no-such-pack", stamps)).toBeUndefined();
});

/* AN ARCHITECTURE-SPECIFIC ARTIFACT MUST ASK WHAT IT IS BEING BUILT FOR, and the failure this guards is
 * invisible until the binary is RUN. The image ships an amd64 and an arm64 half, each built natively on its
 * own runner, and these same fragments compose into overlays on user machines, Apple silicon included. A pack
 * that names one architecture's release unconditionally still BUILDS on the other: the tarball fetches, the
 * digest checks, the files install, and nothing says a word until `--version` reports an exec-format error.
 * That is exactly how the arm64 halves of `images` and `release` broke on the llamacpp pack.
 *
 * `llamacpp-cuda` is the one exemption and it is a statement rather than an oversight: NVIDIA publishes this
 * toolkit's apt repository for x86_64, so that pack is amd64-only by construction. It is also overlay-only,
 * so it never rides the published arm64 half and cannot break it. */
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

/* The pin-lockstep contracts each pack file states in its ponytail comment. These are the tests those
 * comments point at: a bump on one side without the other fails here, not as a runtime skew.
 *   browser : the packed playwright version IS the daemon's, or chromium.executablePath() resolves a
 *              revision the pack never installed.
 *   codex   : the packed CLI IS @openai/codex-sdk's exact dependency, or native app-server turns and
 *              delegated `codex exec` can drive a different engine than the version anchor names.
 *   opencode: the packed CLI matches @opencode-ai/sdk, or the client/server wire API skews. */
test("pack pins are in lockstep with the daemon's own dependency versions", async () => {
    const pin = (content: string, pattern: RegExp): string => {
        const match = pattern.exec(content);
        expect(match?.[1], `no pin matching ${String(pattern)}`).toBeDefined();
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
});

/* The image-compose splice and the daemon must agree on the stamp hash byte for byte: they are two
 * implementations (mjs script / this module) of one protocol, and a divergence makes every standard image
 * read as "not baked", re-proposing packs it already carries. Also pins the placement the layer-cache
 * argument depends on: pre-trees packs above the daemon tree COPY, post-trees packs below it. */
test("compose-image-dockerfile.mjs stamps the hashes this module computes, in the right halves", async () => {
    const composed = execFileSync("node", ["_tools/scripts/compose-image-dockerfile.mjs", "standard"], { cwd: repoRoot, encoding: "utf8" });
    // The PROFILE's packs, not every shipped pack: llamacpp-cuda is deliberately overlay-only (hundreds of MB
    // of CUDA runtime only a GPU-granted sandbox can use), so a stamp for it would be a lie the recompose
    // reads as "already baked" and the GPU option would silently never install its build.
    const profiles = JSON.parse(readFileSync(join(sandboxRoot, "packs/profiles.json"), "utf8")).profiles as Record<string, string[]>;
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
    // The core profile is the Dockerfile untouched: the minimal image is not a variant, it IS the file.
    const core = execFileSync("node", ["_tools/scripts/compose-image-dockerfile.mjs", "core"], { cwd: repoRoot, encoding: "utf8" });
    expect(core).toBe(readFileSync(join(sandboxRoot, "Dockerfile"), "utf8"));
});
