import { createHash, randomBytes } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { SingleFlight } from "@intentic/base/async";
import { statePath } from "../../workspace/layout/state-paths.js";

// Deterministic per-(sandbox seed, profile owner) device: same owner gets the same GPU, cores, memory, locale and
// timezone on every launch; different owners in one sandbox get different machines, different sandboxes get different
// seeds.
// Locale and timezone follow the egress address, not the owner: every profile in a sandbox agrees by default, except
// one bound to a geo exit, which takes its own exit's clock while keeping the same GPU, cores and memory.
// Not farbling (per-site randomization): these profiles are logged in, so stability inside one profile matters more
// than unlinkability across sites.

// 32 random hex bytes; written once, never rotated, and dot-prefixed to stay out of the capability-id namespace.
const seedPath = (root: string): string => statePath(root, ".intentic/local/browser/", ".fingerprint-seed");

let cachedSeed: { root: string; seed: string } | undefined;
const minting = new SingleFlight<string, string>();

// Validates a seed matches what this module writes: 32 bytes, hex.
const SEED_SHAPE = /^[0-9a-f]{64}$/;

// Exclusive create (wx) isn't atomic; staging then linking keeps a concurrent reader from ever seeing a half-written or
// empty seed.
// link fails with EEXIST if another writer already published, keeping the mint exclusive.
const publishSeed = async (path: string, seed: string): Promise<boolean> => {
    const staging = `${path}.${randomBytes(6).toString("hex")}`;
    try {
        await writeFile(staging, seed, { mode: 0o600 });
        await link(staging, path);
        return true;
    } catch {
        return false;
    } finally {
        await rm(staging, { force: true });
    }
};

const mintSeed = async (root: string): Promise<string> => {
    const path = seedPath(root);
    await mkdir(dirname(path), { recursive: true });
    const minted = randomBytes(32).toString("hex");
    if (await publishSeed(path, minted)) {
        return minted;
    }
    // Either another writer won or the read failed; falls back to this mint, stable for the daemon's life.
    const onDisk = (await readFile(path, "utf8").catch(() => "")).trim();
    return SEED_SHAPE.test(onDisk) ? onDisk : minted;
};

// Reads the sandbox seed, minting it on first use; single-flighted per root so concurrent callers on a cold workspace
// all get one mint instead of racing to different ones.
const sandboxSeed = async (root: string): Promise<string> => {
    if (cachedSeed?.root === root) {
        return cachedSeed.seed;
    }
    const seed = await minting.run(root, () => mintSeed(root));
    cachedSeed = { root, seed };
    return seed;
};

// Deterministic byte stream per (seed, owner, field); separate hashes so a new field can't shift others.
const draw = (seed: string, owner: string, field: string): number =>
    createHash("sha256").update(`${seed}\u0000${owner}\u0000${field}`).digest().readUInt32BE(0);

const pick = <T>(table: readonly T[], value: number): T => table[value % table.length] as T;

// GPU vendor/renderer pairs as Chromium on Linux reports them; paired so vendor and renderer never mismatch.
const GPUS: readonly { readonly vendor: string; readonly renderer: string }[] = [
    { vendor: "Google Inc. (Intel)", renderer: "ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)" },
    { vendor: "Google Inc. (Intel)", renderer: "ANGLE (Intel, Mesa Intel(R) Graphics (RPL-P), OpenGL 4.6)" },
    { vendor: "Google Inc. (Intel)", renderer: "ANGLE (Intel, Mesa Intel(R) Iris(R) Xe Graphics (TGL GT2), OpenGL 4.6)" },
    {
        vendor: "Google Inc. (AMD)",
        renderer: "ANGLE (AMD, AMD Radeon Graphics (radeonsi, rembrandt, LLVM 15.0.7, DRM 3.49, 6.5.0-generic), OpenGL 4.6)",
    },
    { vendor: "Google Inc. (AMD)", renderer: "ANGLE (AMD, AMD Radeon RX 6600 (radeonsi, navi23, LLVM 15.0.7, DRM 3.49, 6.5.0-generic), OpenGL 4.6)" },
    { vendor: "Google Inc. (NVIDIA)", renderer: "ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 /PCIe/SSE2, OpenGL 4.5.0)" },
    { vendor: "Google Inc. (NVIDIA)", renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 /PCIe/SSE2, OpenGL 4.5.0)" },
    { vendor: "Google Inc. (NVIDIA)", renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 /PCIe/SSE2, OpenGL 4.5.0)" },
];

// Cores/memory pairs; deviceMemory caps at 8 per spec, cores kept in a laptop's range, not the host's.
const MACHINES: readonly { readonly cores: number; readonly memory: number }[] = [
    { cores: 4, memory: 8 },
    { cores: 8, memory: 8 },
    { cores: 8, memory: 8 },
    { cores: 12, memory: 8 },
    { cores: 16, memory: 8 },
];

// Clock/language per sandbox, must match the shared egress IP; English-family only, the agent reads these pages.
const LOCALES: readonly { readonly locale: string; readonly timezoneId: string }[] = [
    { locale: "en-US", timezoneId: "America/New_York" },
    { locale: "en-US", timezoneId: "America/Chicago" },
    { locale: "en-US", timezoneId: "America/Denver" },
    { locale: "en-US", timezoneId: "America/Los_Angeles" },
    { locale: "en-GB", timezoneId: "Europe/London" },
    { locale: "en-CA", timezoneId: "America/Toronto" },
    { locale: "en-AU", timezoneId: "Australia/Sydney" },
];

// Everything a page can ask about the machine, shared by both launch paths (owner's login window, agent's
// @playwright/mcp) so they never present different machines on one profile.
export interface BrowserFingerprint {
    readonly webglVendor: string;
    readonly webglRenderer: string;
    readonly hardwareConcurrency: number;
    readonly deviceMemory: number;
    readonly locale: string;
    readonly timezoneId: string;
    // navigator.languages, derived from locale so the two can't contradict.
    readonly languages: readonly string[];
}

const languagesFor = (locale: string): readonly string[] => (locale === "en-US" ? [locale, "en"] : [locale, "en-US", "en"]);

// Accept-Language spelled like Chrome: same list as navigator.languages, descending q-values after the first.
// Playwright derives it from locale alone otherwise: a one-tag header under a multi-tag navigator.languages.
export const acceptLanguage = (languages: readonly string[]): string =>
    languages.map((language, index) => (index === 0 ? language : `${language};q=${(1 - index / 10).toFixed(1)}`)).join(",");

// Where a profile is when bound to a geo exit: only clock/language move, GPU/cores/memory stay seed-derived.
// Not LOCALES' shape: languages come from ICU by country (exit/exit-countries.ts), and the caller supplies the whole
// triple.
export interface FingerprintPlace {
    readonly locale: string;
    readonly timezoneId: string;
    readonly languages: readonly string[];
}

// Device for one profile owner, including `web` (the credential-free browser), which still needs a plausible GPU rather
// than announcing it has none.
export const browserFingerprint = async (root: string, owner: string, place?: FingerprintPlace | undefined): Promise<BrowserFingerprint> => {
    const seed = await sandboxSeed(root);
    const gpu = pick(GPUS, draw(seed, owner, "gpu"));
    const machine = pick(MACHINES, draw(seed, owner, "machine"));
    // Drawn against a constant owner: the address's clock, shared by every profile leaving by it (`place` excepted).
    const here = pick(LOCALES, draw(seed, "", "place"));
    const where: FingerprintPlace = place ?? { locale: here.locale, timezoneId: here.timezoneId, languages: languagesFor(here.locale) };
    return {
        webglVendor: gpu.vendor,
        webglRenderer: gpu.renderer,
        hardwareConcurrency: machine.cores,
        deviceMemory: machine.memory,
        locale: where.locale,
        timezoneId: where.timezoneId,
        languages: where.languages,
    };
};
