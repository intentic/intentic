import { createHash, randomBytes } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { SingleFlight } from "@intentic/base/async";
import { statePath } from "../workspace/state-paths.js";

/* ONE STABLE, PLAUSIBLE DEVICE PER PROFILE OWNER.
 *
 * The problem this replaces: every browser in every sandbox everywhere reported the SAME hand-written lie, an
 * "Intel Iris OpenGL Engine" GPU on an America/New_York clock. Three things were wrong with that.
 *
 *   1. It was a SHARED fingerprint. Identical values across every install of this product are a marker for the
 *      product, not a disguise: one site that learns the combination recognises every sandbox that ever visits.
 *   2. It was INCONSISTENT. "Intel Iris OpenGL Engine" is the string a Mac reports; the user agent underneath
 *      it says Linux. Detectors weight internal contradictions far more heavily than unusual values, so a
 *      mismatched pair is worse than reporting nothing at all.
 *   3. Every account in one sandbox shared it, so the GPU string, which is the most identifying signal that
 *      SURVIVES an IP change, linked an owner's accounts to each other for free.
 *
 * What replaces it: a per-sandbox secret seed, and a device derived from it per profile owner. Deterministic,
 * so the same owner presents the same device on every launch forever (a device that changes mid-session is the
 * exact signal session-binding checks are built to catch, and these profiles hold live logins). Different per
 * owner, so two identities in one sandbox are two machines. Different per sandbox, because the seed is random
 * and never leaves the volume.
 *
 * WHY NOT FARBLING (Brave's per-site randomisation). It answers a different question. Farbling exists to stop a
 * site linking a visitor across sites, and these profiles are logged in: the cookie already says who they are,
 * so randomising the hardware underneath it buys no privacy and costs real sessions. Stability inside a profile
 * is the property worth having here; unlinkability BETWEEN profiles is what this delivers instead.
 *
 * LOCALE AND TIMEZONE FOLLOW THE EGRESS, NOT THE OWNER, which is a rule about the ADDRESS rather than about
 * the seed. Three accounts on one IP claiming New York, Berlin and Sydney is a contradiction a geolocation
 * check catches immediately. So by default the clock is a property of the SANDBOX and every owner in it
 * agrees, because by default every profile leaves by the same address.
 *
 * A profile BOUND TO A GEO EXIT is the exception, and it is the same rule rather than a break from it: that
 * profile no longer leaves by the sandbox's address, so agreeing with the sandbox's clock would be the
 * contradiction. Its caller passes the exit's country as `place` (browser-exit.ts resolves it, exit/ owns
 * where it actually comes out), and everything else about the device, the GPU, the cores, the memory, still
 * comes from the seed: the machine is the same machine, sitting somewhere else. */

// The seed file: 32 random bytes, hex, written once and never rotated (rotating it would re-fingerprint every
// live login at once). It lives beside the profiles on the /work volume, so it survives a sandbox rebuild
// exactly as the sessions it describes do. The leading dot keeps it out of the capability-id namespace the
// rest of that directory uses (`<owner>`, `<owner>.connected`, `<owner>.passkeys.json`).
const seedPath = (root: string): string => statePath(root, ".intentic/local/browser/", ".fingerprint-seed");

let cachedSeed: { root: string; seed: string } | undefined;
const minting = new SingleFlight<string, string>();

// What a seed read back off disk has to look like before it is believed: the 32 bytes this module writes, hex.
const SEED_SHAPE = /^[0-9a-f]{64}$/;

/* PUBLISHING A FRESH SEED SO NO READER CAN SEE HALF OF IT.
 *
 * `writeFile(…, { flag: "wx" })` is exclusive but it is not atomic: it CREATES the file and then writes the
 * bytes, and whoever lost the race opens it in between, reads an EMPTY STRING, and uses that as the sandbox's
 * seed. Two profiles in one sandbox then derive two different machines from two different seeds, which is the
 * property at the top of this file broken by an interleaving rather than by anything anyone wrote.
 *
 * Staging the bytes under a private name and LINKING them into place closes the window: the link is atomic, it
 * fails with EEXIST if another writer got there first (so the mint stays exclusive), and a reader sees either no
 * file at all or the whole seed. */
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
    // Either it already existed or the write lost the race; the file on disk is the answer either way. A read
    // that fails, or that comes back as anything but a seed, leaves the process seed, which is stable for this
    // daemon's lifetime and beats throwing a browser away over a fingerprint detail.
    const onDisk = (await readFile(path, "utf8").catch(() => "")).trim();
    return SEED_SHAPE.test(onDisk) ? onDisk : minted;
};

/* Read the sandbox's seed, minting it on first use.
 *
 * ONE MINT PER ROOT AT A TIME, and single-flighting it is about the device rather than about the cost of a
 * second hash. Two callers reaching a cold workspace together each minted their own seed, and each fell back to
 * its own if the publish or the read-back hiccuped: two profiles in one sandbox, two machines, two clocks, on
 * one egress address. Everyone who asks while a mint is in flight now gets that mint's answer. */
const sandboxSeed = async (root: string): Promise<string> => {
    if (cachedSeed?.root === root) {
        return cachedSeed.seed;
    }
    const seed = await minting.run(root, () => mintSeed(root));
    cachedSeed = { root, seed };
    return seed;
};

// A deterministic byte stream for one (seed, owner, field). Separate fields draw from separate hashes so that
// adding a field later does not shift the values of the ones already in use by live profiles.
const draw = (seed: string, owner: string, field: string): number =>
    createHash("sha256").update(`${seed}\u0000${owner}\u0000${field}`).digest().readUInt32BE(0);

const pick = <T>(table: readonly T[], value: number): T => table[value % table.length] as T;

/* GPU strings as Chromium on Linux actually reports them: ANGLE's own format, with the vendor prefixed
 * "Google Inc. (…)" the way `UNMASKED_VENDOR_WEBGL` does on a real desktop. These are pairs rather than two
 * independent tables because a "Google Inc. (NVIDIA)" vendor beside an AMD renderer is precisely the kind of
 * impossible combination that a naive randomiser produces and a detector reads as automation. */
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

/* Cores and memory, as PAIRS for the same reason. `deviceMemory` is not the real figure: the spec quantises it
 * to a power of two and CAPS it at 8, so 8 is what every machine with 16 GiB or more reports, and a larger
 * number would be impossible rather than merely unusual. The container itself reports the HOST's core count,
 * which on the machines this runs on is routinely 32 or 64: a desktop browser claiming that is a tell on its
 * own, so the count is pulled back into the range real laptops occupy. */
const MACHINES: readonly { readonly cores: number; readonly memory: number }[] = [
    { cores: 4, memory: 8 },
    { cores: 8, memory: 8 },
    { cores: 8, memory: 8 },
    { cores: 12, memory: 8 },
    { cores: 16, memory: 8 },
];

/* Clock and language, per SANDBOX (see the module comment: they must agree with the egress IP, which every
 * profile shares). English-family only, deliberately: the agent READS these pages, and a profile that flips
 * a site into German buys a little entropy at the cost of every instruction the agent is trying to follow. */
const LOCALES: readonly { readonly locale: string; readonly timezoneId: string }[] = [
    { locale: "en-US", timezoneId: "America/New_York" },
    { locale: "en-US", timezoneId: "America/Chicago" },
    { locale: "en-US", timezoneId: "America/Denver" },
    { locale: "en-US", timezoneId: "America/Los_Angeles" },
    { locale: "en-GB", timezoneId: "Europe/London" },
    { locale: "en-CA", timezoneId: "America/Toronto" },
    { locale: "en-AU", timezoneId: "Australia/Sydney" },
];

// One profile owner's device. Everything a page can ask about the machine, in one object, so the two launch
// paths (the owner's own login window and the agent's @playwright/mcp) cannot drift apart: they share a
// profile, and a site that watched the owner sign in on one machine must not then meet the agent on another.
export interface BrowserFingerprint {
    readonly webglVendor: string;
    readonly webglRenderer: string;
    readonly hardwareConcurrency: number;
    readonly deviceMemory: number;
    readonly locale: string;
    readonly timezoneId: string;
    // `navigator.languages`, derived from the locale so the two never contradict each other.
    readonly languages: readonly string[];
}

const languagesFor = (locale: string): readonly string[] => (locale === "en-US" ? [locale, "en"] : [locale, "en-US", "en"]);

/* `Accept-Language`, spelled the way Chrome spells it: the SAME list `navigator.languages` reports, with
 * descending q-values after the first.
 *
 * This exists because Playwright derives the header from `locale` ALONE, which sends a one-entry
 * `Accept-Language: de-DE` underneath a three-entry `navigator.languages`. That is not a small discrepancy: a
 * header and a JS property disagreeing about the same fact is exactly the internal contradiction detectors
 * weight above any unusual value, and it would arrive precisely on the profiles that moved country, which are
 * the ones that can least afford it. Both launch paths pass this, for the same reason they share everything
 * else in this module: they share a profile, so a site must meet one machine whichever is driving. */
export const acceptLanguage = (languages: readonly string[]): string =>
    languages.map((language, index) => (index === 0 ? language : `${language};q=${(1 - index / 10).toFixed(1)}`)).join(",");

/* Where this profile is, when it is NOT wherever the sandbox is: a profile bound to a geo exit. Only the
 * clock and the language, because that is the whole of what moving changes, the GPU, cores and memory are
 * still drawn from the seed below, so the same machine turns up in the new place rather than a new machine.
 *
 * Not the same shape as `LOCALES`: an exit can come out of a country nobody would draw from that table, and
 * its `languages` is derived from the country by ICU (exit/exit-countries.ts) rather than from an en-family
 * locale string. The caller hands the whole triple over so this module stays ignorant of where exits live. */
export interface FingerprintPlace {
    readonly locale: string;
    readonly timezoneId: string;
    readonly languages: readonly string[];
}

// The device for one profile owner. `web`, the credential-free browser, is an owner like any other here: it
// holds no login, but it should still not announce itself as the one browser in the world with no GPU.
export const browserFingerprint = async (root: string, owner: string, place?: FingerprintPlace | undefined): Promise<BrowserFingerprint> => {
    const seed = await sandboxSeed(root);
    const gpu = pick(GPUS, draw(seed, owner, "gpu"));
    const machine = pick(MACHINES, draw(seed, owner, "machine"));
    /* Drawn against a constant owner, not this one: the sandbox's clock belongs to the sandbox's ADDRESS, and
     * every profile leaving by that address must return the same answer. A profile with its own address
     * (`place`, a geo exit) is the exception that keeps the rule, see the module comment. */
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
