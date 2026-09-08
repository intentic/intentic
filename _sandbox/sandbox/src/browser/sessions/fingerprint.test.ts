import { expect, test } from "vitest";
import { acceptLanguage, type BrowserFingerprint } from "./fingerprint.js";
import { stealthInit } from "./stealth.js";

// Pure half: script output for a literal device. Deriving the device touches the workspace; that's tested in
// fingerprint.integration.test.ts.
const device: BrowserFingerprint = {
    webglVendor: "Google Inc. (NVIDIA)",
    webglRenderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 /PCIe/SSE2, OpenGL 4.5.0)",
    hardwareConcurrency: 12,
    deviceMemory: 8,
    locale: "en-GB",
    timezoneId: "Europe/London",
    languages: ["en-GB", "en-US", "en"],
};

test("the init script carries the device it was given", () => {
    const script = stealthInit(device);
    expect(script).toContain(JSON.stringify(device.webglVendor));
    expect(script).toContain(JSON.stringify(device.webglRenderer));
    expect(script).toContain(`'hardwareConcurrency', ${String(device.hardwareConcurrency)}`);
    expect(script).toContain(`'deviceMemory', ${String(device.deviceMemory)}`);
    expect(script).toContain(JSON.stringify(device.languages));
});

test("the constants that identified this product are gone", () => {
    const script = stealthInit(device);
    expect(script).not.toContain("Intel Iris OpenGL Engine");
    expect(script).not.toContain("America/New_York");
    expect(script).not.toMatch(/\[1,\s*2,\s*3,\s*4,\s*5\]/);
});

// Source must read as native code, or the patch itself becomes the tell.
test("the patched WebGL getter does not advertise itself", () => {
    expect(stealthInit(device)).toContain("[native code]");
});

// Playwright's own Accept-Language uses `locale` alone, one tag against a multi-tag navigator.languages; spelled out
// from that same list here.
test("Accept-Language spells out the same list the init script installs", () => {
    expect(acceptLanguage(device.languages)).toBe("en-GB,en-US;q=0.9,en;q=0.8");
    expect(acceptLanguage(["de-DE", "de", "en"])).toBe("de-DE,de;q=0.9,en;q=0.8");
});

// No trailing ";q=1.0" on a single-language header; real browsers don't write one.
test("a one-language device gets a bare header", () => {
    expect(acceptLanguage(["en-US"])).toBe("en-US");
});
