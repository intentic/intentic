import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { browserFingerprint } from "./fingerprint.js";
import { stealthInit } from "./stealth.js";

// Skips when Chromium isn't installed on disk.
const chromiumInstalled = async (): Promise<boolean> => {
    try {
        const { chromium } = await import("playwright");
        return existsSync(chromium.executablePath());
    } catch {
        return false;
    }
};

// Fresh workspace root; the seed is minted per workspace.
const tempRoot = (): string => mkdtempSync(join(tmpdir(), "fingerprint-live-"));

test("one owner gets one device, on every launch, for the life of the sandbox", async () => {
    const root = tempRoot();
    const first = await browserFingerprint(root, "reddit-work");
    const second = await browserFingerprint(root, "reddit-work");
    expect(second).toEqual(first);
});

test("two owners in one sandbox are two machines", async () => {
    const root = tempRoot();
    const devices = await Promise.all(["alice", "bob", "carol", "dave", "erin", "frank"].map((owner) => browserFingerprint(root, owner)));
    const machines = new Set(devices.map((device) => `${device.webglRenderer}|${String(device.hardwareConcurrency)}`));
    expect(machines.size).toBeGreaterThan(1);
});

// Checks six owners at once: one could coincidentally collide across sandboxes by chance, but all six agreeing means
// the seeds didn't differ.
test("the same owner in two sandboxes is not the same machine", async () => {
    const owners = ["reddit", "alice", "bob", "carol", "dave", "erin"];
    const machines = async (root: string): Promise<string> =>
        (await Promise.all(owners.map((owner) => browserFingerprint(root, owner))))
            .map((device) => `${device.webglRenderer}|${String(device.hardwareConcurrency)}`)
            .join("/");
    const [here, there] = await Promise.all([machines(tempRoot()), machines(tempRoot())]);
    expect(here).not.toBe(there);
});

// Clock/language aren't per-owner: every profile in a sandbox shares one exit IP, so differing clocks would flag as a
// contradiction.
test("every profile in one sandbox agrees on the clock and the language", async () => {
    const root = tempRoot();
    const [one, two] = await Promise.all([browserFingerprint(root, "alice"), browserFingerprint(root, "bob")]);
    expect(two.timezoneId).toBe(one.timezoneId);
    expect(two.locale).toBe(one.locale);
});

// Guards the race when several profiles ask before the seed file exists: the losing writer must still read back the
// winner's seed.
test("profiles that all reach a cold workspace at once still agree on one device", async () => {
    const root = tempRoot();
    const owners = ["alice", "bob", "carol", "dave", "erin", "frank", "grace", "heidi"];
    const devices = await Promise.all(owners.map((owner) => browserFingerprint(root, owner)));
    expect(new Set(devices.map((device) => `${device.timezoneId}|${device.locale}`)).size).toBe(1);
    // Confirms the seed is persisted: a later launch reproduces the same devices.
    const again = await Promise.all(owners.map((owner) => browserFingerprint(root, owner)));
    expect(again).toEqual(devices);
});

// A bound profile's clock/language follow its exit's country, but GPU/cores/memory stay derived from the seed, so it's
// the same machine in a new place.
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
    // Binding one profile's exit doesn't move an unbound neighbor's clock.
    expect(neighbour.timezoneId).toBe(home.timezoneId);
    expect(neighbour.locale).toBe(home.locale);
});

test("the language and the clock belong to the same place", async () => {
    const zones: Record<string, string> = {
        "en-US": "America/",
        "en-GB": "Europe/London",
        "en-CA": "America/Toronto",
        "en-AU": "Australia/Sydney",
    };
    for (const owner of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
        const device = await browserFingerprint(tempRoot(), owner);
        expect(zones[device.locale]).toEqual(expect.any(String));
        expect(device.timezoneId.startsWith(zones[device.locale] as string)).toBe(true);
        // languages[0] must equal locale, or the header contradicts the property.
        expect(device.languages[0]).toBe(device.locale);
    }
});

// Vendor and renderer must belong to the same GPU family; a mismatched pair reads as automation.
test("the GPU is one a Linux desktop could actually report", async () => {
    for (const owner of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
        const device = await browserFingerprint(tempRoot(), owner);
        const make = /^Google Inc\. \((?<make>Intel|AMD|NVIDIA)\)$/.exec(device.webglVendor)?.groups?.["make"];
        expect(make).toEqual(expect.any(String));
        expect(device.webglRenderer.startsWith(`ANGLE (${make as string},`)).toBe(true);
        expect(device.webglRenderer).not.toContain("SwiftShader");
        // deviceMemory caps at 8 per spec; hardwareConcurrency stays in a desktop's range, not a build server's.
        expect(device.deviceMemory).toBeLessThanOrEqual(8);
        expect(device.hardwareConcurrency).toBeLessThanOrEqual(16);
        expect(device.hardwareConcurrency).toBeGreaterThanOrEqual(4);
    }
});

// Checks what the page actually receives, not just what's derived.
// Evaluated as a string because the daemon compiles without DOM lib types.
test("a page sees the owner's device, not the server underneath it", { timeout: 60_000 }, async () => {
    if (!(await chromiumInstalled())) {
        return;
    }
    const { chromium } = await import("playwright");
    const device = await browserFingerprint(tempRoot(), "reddit");
    // Full executablePath, not headless (the image deletes that shell); fine here since only script values matter.
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

        // SwiftShader is what a GPU-less machine reports; no desktop does.
        expect(seen.vendor).toBe(device.webglVendor);
        expect(seen.renderer).toBe(device.webglRenderer);
        expect(seen.renderer).not.toContain("SwiftShader");
        // Confirms hardwareConcurrency is overridden; the host's real core count would give away a container.
        expect(seen.cores).toBe(device.hardwareConcurrency);
        expect(seen.memory).toBe(device.deviceMemory);
        expect(seen.webdriver).toBeUndefined();
        // locale and navigator.language must agree, or the Accept-Language header contradicts the script.
        expect(seen.languages).toEqual([...device.languages]);
        expect(seen.language).toBe(device.locale);
        expect(seen.timezone).toBe(device.timezoneId);
        // getParameter's source must still read as native code, not the patch.
        expect(seen.source).toContain("[native code]");
    } finally {
        await browser.close();
    }
});
