import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { browserFingerprint } from "./fingerprint.js";
import { stealthInit } from "./stealth.js";

// The same gate the other browser tests use: without Chromium on disk there is nothing to look at.
const chromiumInstalled = async (): Promise<boolean> => {
    try {
        const { chromium } = await import("playwright");
        return existsSync(chromium.executablePath());
    } catch {
        return false;
    }
};

// Each call is a fresh SANDBOX: the seed is minted per workspace, so a new root is a new install of the product.
const tempRoot = (): string => mkdtempSync(join(tmpdir(), "fingerprint-live-"));

/* THE PROPERTY THE LOGINS DEPEND ON. These profiles hold live cookies, and a device that changes underneath one
 * is the exact signal session-binding checks are built to catch: the answer is a logout, a captcha, or a flagged
 * account. So the derivation has to be a pure function of (sandbox seed, owner) and nothing else — no clock, no
 * randomness at call time, no dependence on how many turns have run. */
test("one owner gets one device, on every launch, for the life of the sandbox", async () => {
    const root = tempRoot();
    const first = await browserFingerprint(root, "reddit-work");
    const second = await browserFingerprint(root, "reddit-work");
    expect(second).toEqual(first);
});

/* …and the reason to derive it per owner at all: the GPU string is the identifying signal that SURVIVES an IP
 * change, so two profiles sharing one would be linkable to each other for free, which is what the single
 * hand-written constant this replaces did to every account in every sandbox at once. */
test("two owners in one sandbox are two machines", async () => {
    const root = tempRoot();
    const devices = await Promise.all(["alice", "bob", "carol", "dave", "erin", "frank"].map((owner) => browserFingerprint(root, owner)));
    const machines = new Set(devices.map((device) => `${device.webglRenderer}|${String(device.hardwareConcurrency)}`));
    expect(machines.size).toBeGreaterThan(1);
});

/* The other half of that: the values must not be a signature for THIS PRODUCT. Every install used to report the
 * same GPU on the same clock, which identifies the sandbox rather than disguising it. Two sandboxes mint two
 * seeds, so the same owner name in each is a different machine.
 *
 * COMPARED ACROSS SEVERAL OWNERS AT ONCE, not one, and the difference is the whole reliability of this test.
 * One owner draws from 8 GPUs × 5 machines, so two sandboxes agree on that one owner about 3% of the time by
 * chance — measured, not estimated — which is a failure every thirtieth run for a property that is not broken.
 * Six owners have to agree on ALL SIX before this fails, which happens if and only if the seeds did not differ:
 * the thing actually being asserted. */
test("the same owner in two sandboxes is not the same machine", async () => {
    const owners = ["reddit", "alice", "bob", "carol", "dave", "erin"];
    const machines = async (root: string): Promise<string> =>
        (await Promise.all(owners.map((owner) => browserFingerprint(root, owner))))
            .map((device) => `${device.webglRenderer}|${String(device.hardwareConcurrency)}`)
            .join("/");
    const [here, there] = await Promise.all([machines(tempRoot()), machines(tempRoot())]);
    expect(here).not.toBe(there);
});

/* WHY THE CLOCK IS NOT PER OWNER. Every profile in a sandbox leaves by the same IP. Three accounts on one
 * address claiming New York, Berlin and Sydney is a contradiction a geolocation check catches on sight, and
 * detectors weight contradictions above unusual values. */
test("every profile in one sandbox agrees on the clock and the language", async () => {
    const root = tempRoot();
    const [one, two] = await Promise.all([browserFingerprint(root, "alice"), browserFingerprint(root, "bob")]);
    expect(two.timezoneId).toBe(one.timezoneId);
    expect(two.locale).toBe(one.locale);
});

/* THE EXCEPTION THAT KEEPS THE RULE. The clock agrees across a sandbox because every profile leaves by the
 * same address — and a profile bound to a geo exit does not. Handed that exit's country as its `place`, it
 * claims that country's clock and language while every unbound profile beside it still claims the sandbox's.
 *
 * What must NOT move is the rest of the device: the GPU, the cores and the memory are still drawn from the
 * seed, so a site that met this profile before it was bound meets the same machine afterwards, in a new place.
 * A device that changes underneath a live cookie is exactly what session-binding checks are built to catch. */
test("a profile behind a geo exit takes that country's clock, and keeps its own machine", async () => {
    const root = tempRoot();
    const berlin = { locale: "de-DE", timezoneId: "Europe/Berlin", languages: ["de-DE", "de", "en"] };
    const [home, abroad, neighbour] = await Promise.all([
        browserFingerprint(root, "alice"),
        browserFingerprint(root, "alice", berlin),
        browserFingerprint(root, "bob"),
    ]);
    expect(abroad.locale).toBe("de-DE");
    expect(abroad.timezoneId).toBe("Europe/Berlin");
    expect(abroad.languages).toEqual(["de-DE", "de", "en"]);
    // Same owner, same hardware: only the place moved.
    expect(abroad.webglRenderer).toBe(home.webglRenderer);
    expect(abroad.hardwareConcurrency).toBe(home.hardwareConcurrency);
    expect(abroad.deviceMemory).toBe(home.deviceMemory);
    // And the unbound profile beside it is untouched: binding one exit does not move the sandbox's clock.
    expect(neighbour.timezoneId).toBe(home.timezoneId);
    expect(neighbour.locale).toBe(home.locale);
});

// The pair has to be one a real place could produce: an en-GB browser on a Sydney clock is a tell of its own.
test("the language and the clock belong to the same place", async () => {
    const zones: Record<string, string> = {
        "en-US": "America/",
        "en-GB": "Europe/London",
        "en-CA": "America/Toronto",
        "en-AU": "Australia/Sydney",
    };
    for (const owner of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
        const device = await browserFingerprint(tempRoot(), owner);
        expect(zones[device.locale]).toBeDefined();
        expect(device.timezoneId.startsWith(zones[device.locale] as string)).toBe(true);
        // navigator.languages must lead with the very locale the context is set to, or the header and the
        // property contradict each other.
        expect(device.languages[0]).toBe(device.locale);
    }
});

/* The GPU pair has to be internally consistent too: an "(NVIDIA)" vendor beside an AMD renderer is precisely
 * what a naive randomiser produces, and it is read as automation rather than as an unusual machine. It also has
 * to be spelled the way Chromium on Linux spells it — the constant this replaces reported a macOS string under
 * a Linux user agent. */
test("the GPU is one a Linux desktop could actually report", async () => {
    for (const owner of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
        const device = await browserFingerprint(tempRoot(), owner);
        const make = /^Google Inc\. \((?<make>Intel|AMD|NVIDIA)\)$/.exec(device.webglVendor)?.groups?.["make"];
        expect(make).toBeDefined();
        expect(device.webglRenderer.startsWith(`ANGLE (${make as string},`)).toBe(true);
        expect(device.webglRenderer).not.toContain("SwiftShader");
        // deviceMemory is quantised and capped at 8 by the spec, so anything above it is impossible rather
        // than merely unusual; the core count stays in the range desktops occupy, not a build server's.
        expect(device.deviceMemory).toBeLessThanOrEqual(8);
        expect(device.hardwareConcurrency).toBeLessThanOrEqual(16);
        expect(device.hardwareConcurrency).toBeGreaterThanOrEqual(4);
    }
});

/* THE TESTS ABOVE CHECK WHAT WE DERIVE. This one checks what a PAGE actually receives, which is the only thing
 * that was ever true or false about any of it: the derivation could be perfect and the init script could still
 * be landing after the page's own scripts, or patching a prototype the page never reads.
 *
 * Evaluates travel as strings: the daemon compiles without the DOM lib, and a typed callback would drag
 * `navigator` into a node tsconfig for a handful of expressions. */
test("a page sees the owner's device, not the server underneath it", { timeout: 60_000 }, async () => {
    if (!(await chromiumInstalled())) {
        return;
    }
    const { chromium } = await import("playwright");
    const device = await browserFingerprint(tempRoot(), "reddit");
    /* `executablePath` is the FULL browser, exactly as both production launches pass it: the image deletes
     * the headless shell on purpose (packs/browser.Dockerfile), and a bare `headless: true` would reach for
     * that shell and fail. Headless is fine HERE because the assertion is about the script's values, not
     * about the headless tell — which is what Xvfb answers, elsewhere. */
    const browser = await chromium.launch({
        headless: true,
        executablePath: chromium.executablePath(),
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    try {
        const context = await browser.newContext({ locale: device.locale, timezoneId: device.timezoneId });
        await context.addInitScript(stealthInit(device));
        const page = await context.newPage();
        await page.goto("about:blank");
        const seen = (await page.evaluate(`(() => {
                const gl = document.createElement('canvas').getContext('webgl');
                const ext = gl.getExtension('WEBGL_debug_renderer_info');
                return {
                    vendor: gl.getParameter(ext.UNMASKED_VENDOR_WEBGL),
                    renderer: gl.getParameter(ext.UNMASKED_RENDERER_WEBGL),
                    cores: navigator.hardwareConcurrency,
                    memory: navigator.deviceMemory,
                    languages: [...navigator.languages],
                    language: navigator.language,
                    webdriver: navigator.webdriver,
                    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                    source: WebGLRenderingContext.prototype.getParameter.toString(),
                };
            })()`)) as {
            vendor: string;
            renderer: string;
            cores: number;
            memory: number;
            languages: string[];
            language: string;
            webdriver: unknown;
            timezone: string;
            source: string;
        };

        // The GPU: the whole reason this script exists. SwiftShader is what a machine with no GPU reports,
        // and no desktop reports it.
        expect(seen.vendor).toBe(device.webglVendor);
        expect(seen.renderer).toBe(device.webglRenderer);
        expect(seen.renderer).not.toContain("SwiftShader");
        // The server underneath: this container sees the host's cores, which no laptop has.
        expect(seen.cores).toBe(device.hardwareConcurrency);
        expect(seen.memory).toBe(device.deviceMemory);
        expect(seen.webdriver).toBeUndefined();
        // The context's locale and the page's own property have to be the same answer, or the
        // Accept-Language header contradicts the script.
        expect(seen.languages).toEqual([...device.languages]);
        expect(seen.language).toBe(device.locale);
        expect(seen.timezone).toBe(device.timezoneId);
        // A page that reads the patched function's source must see native code, not the patch.
        expect(seen.source).toContain("[native code]");
    } finally {
        await browser.close();
    }
});
