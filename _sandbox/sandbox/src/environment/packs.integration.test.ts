import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
    for (const name of ["docker", "browser", "codex", "cursor", "opencode", "translator"]) {
        expect(byName.get(name)?.overlayable, `${name} must be overlay-installable`).toBe(true);
        expect(byName.get(name)?.postTrees, `${name} must splice above the tree COPYs`).toBe(false);
    }
    /* THE ONE PACK NO PROFILE MAY BAKE. @cursor/sdk is all-rights-reserved and grants no redistribution, so a
     * published image carrying it would be redistributing it to everyone who pulls that image. An explicit
     * Connect action downloads it onto the owner's running machine, and the resulting credential asks for the
     * durable overlay rebuild (environment/provider-packs.ts). Asserted here rather than left to review,
     * because someone adding it to a profile creates a licence problem rather than a broken build. */
    for (const profile of Object.values(profiles)) {
        expect(profile, "no profile may bake the cursor pack: its licence grants no redistribution").not.toContain("cursor");
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
    /* cursor: the packed module IS the version the daemon was compiled against. A skew here is worse than the
     * CLI ones above, because the daemon does not merely TALK to this dependency, it imports it: the types it
     * type-checked against and the module it loads at runtime would be different releases, with nothing at
     * either end to notice. */
    const cursor = (await readPack("cursor"))!;
    expect(pin(cursor.content, /@cursor\/sdk@(\S+) /)).toBe(version("@cursor/sdk"));
});

/* THE OTHER HALF OF THE LOCKSTEP: not what the pack file SAYS, but what the machine running this actually has.
 *
 * The test above compares two strings in the repository, which catches a bump on one side and not the other and
 * catches nothing at all about the binary a turn will really drive. Those are different failures. A pack whose
 * RUN line silently resolved something else, an image built before the last bump, a developer with an older
 * global install shadowing it on PATH, all leave the pins in perfect agreement and the product running a
 * version nothing in this repository has ever been checked against. That matters most for the conformance tier
 * (codex-wire.e2e.test.ts), whose entire claim is that it exercises the shipped article: run against the wrong
 * CLI it still passes, and proves something about a version nobody ships.
 *
 * ABSENT IS NOT A FAILURE, WRONG IS. A dev checkout with no packs installed has nothing to check and must not
 * go red for it; that is the same judgement `e2eTier` makes about credentials. But a CLI that IS here and
 * reports a version the packs do not name is a skew, and it is named as one. */
test("a provider CLI present on this machine reports the version its pack pins", async () => {
    const pinOf = async (pack: string, pattern: RegExp): Promise<string> => {
        const match = pattern.exec((await readPack(pack))!.content);
        expect(match?.[1], `no pin matching ${String(pattern)} in the ${pack} pack`).toEqual(expect.any(String));
        return match![1]!;
    };
    // `--version` output with the surrounding words dropped: codex answers "codex-cli 0.147.0", opencode answers
    // a bare number. Asserting on the NUMBER rather than the whole line keeps this from failing on a vendor
    // reformatting its banner, which is not a skew.
    const reported = (binary: string): string | undefined => {
        try {
            const output = execFileSync(binary, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000 });
            return /(\d+\.\d+\.\d+)/.exec(output)?.[1];
        } catch {
            // Not installed here, or not answering: nothing to compare, which is the dev-checkout case.
            return undefined;
        }
    };

    const codexVersion = reported("codex");
    if (codexVersion !== undefined) {
        expect(codexVersion, "the codex on PATH is not the version packs/codex.Dockerfile pins").toBe(await pinOf("codex", /@openai\/codex@(\S+) /));
    }

    const opencodeVersion = reported("opencode");
    if (opencodeVersion !== undefined) {
        expect(opencodeVersion, "the opencode on PATH is not the version packs/opencode.Dockerfile pins").toBe(
            await pinOf("opencode", /opencode-ai@(\S+) /),
        );
    }

    /* @cursor/sdk is a MODULE the daemon imports rather than a binary, so it is read where the daemon resolves
     * it from (cursor-sdk.ts). This is the skew with no symptom until a turn is already running: the daemon
     * type-checked against the catalog's version and imports whatever is in that prefix, and a mismatch surfaces
     * as a TypeError inside somebody's turn. */
    const cursorDir = process.env["INTENTIC_CURSOR_SDK_DIR"] ?? "/opt/cursor-sdk";
    const cursorManifest = join(cursorDir, "node_modules/@cursor/sdk/package.json");
    if (existsSync(cursorManifest)) {
        expect(JSON.parse(readFileSync(cursorManifest, "utf8")).version, `the @cursor/sdk in ${cursorDir} is not the version packs/cursor.Dockerfile pins`).toBe(
            await pinOf("cursor", /@cursor\/sdk@(\S+) /),
        );
    }
});

/* The image-compose splice and the daemon must agree on the stamp hash byte for byte: they are two
 * implementations (mjs script / this module) of one protocol, and a divergence makes every standard image
 * read as "not baked", re-proposing packs it already carries. Also pins the placement the layer-cache
 * argument depends on: pre-trees packs above the daemon tree COPY, post-trees packs below it. */
test("compose-image-dockerfile.mjs stamps the hashes this module computes, in the right halves", async () => {
    const composed = execFileSync("node", ["_tools/scripts/image/compose-image-dockerfile.mjs", "standard"], { cwd: repoRoot, encoding: "utf8" });
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
    const core = execFileSync("node", ["_tools/scripts/image/compose-image-dockerfile.mjs", "core"], { cwd: repoRoot, encoding: "utf8" });
    expect(core).toBe(readFileSync(join(sandboxRoot, "Dockerfile"), "utf8"));
});
