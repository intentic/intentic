import { expect, test } from "vitest";
import { acceptLanguage, type BrowserFingerprint } from "./fingerprint.js";
import { stealthInit } from "./stealth.js";

/* The PURE half: what the init script says, given a device. Deriving the device touches the workspace (the seed
 * file), so every test that needs a root lives in fingerprint.integration.test.ts and this one hands the script
 * a literal instead. */
const device: BrowserFingerprint = {
    webglVendor: "Google Inc. (NVIDIA)",
    webglRenderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 /PCIe/SSE2, OpenGL 4.5.0)",
    hardwareConcurrency: 12,
    deviceMemory: 8,
    locale: "en-GB",
    timezoneId: "Europe/London",
    languages: ["en-GB", "en-US", "en"],
};

// The script is per-owner data, not a constant: the whole point of the change is that it stopped being one.
test("the init script carries the device it was given", () => {
    const script = stealthInit(device);
    expect(script).toContain(JSON.stringify(device.webglVendor));
    expect(script).toContain(JSON.stringify(device.webglRenderer));
    expect(script).toContain(`'hardwareConcurrency', ${String(device.hardwareConcurrency)}`);
    expect(script).toContain(`'deviceMemory', ${String(device.deviceMemory)}`);
    expect(script).toContain(JSON.stringify(device.languages));
});

/* THE TWO LIES THAT ARE GONE, pinned so they cannot come back.
 *
 * "Intel Iris OpenGL Engine" was the single hand-written GPU every install of this product reported: a macOS
 * string, under a Linux user agent, identical everywhere. And `navigator.plugins = [1,2,3,4,5]` was an array of
 * bare integers, which is not a shape any browser has ever returned for that property — headed Chromium ships a
 * real PDF viewer entry anyway, so the branch could only ever make the page look stranger. */
test("the constants that identified this product are gone", () => {
    const script = stealthInit(device);
    expect(script).not.toContain("Intel Iris OpenGL Engine");
    expect(script).not.toContain("America/New_York");
    expect(script).not.toMatch(/\[1,\s*2,\s*3,\s*4,\s*5\]/);
});

// A page that reads the patched function's source must see native code rather than the patch, or the fix for
// one tell becomes a louder tell of its own.
test("the patched WebGL getter does not advertise itself", () => {
    expect(stealthInit(device)).toContain("[native code]");
});

/* THE HEADER AND THE JS PROPERTY HAVE TO AGREE. Playwright builds `Accept-Language` from `locale` alone, which
 * sends one tag under a three-tag `navigator.languages`: a header contradicting a property about the same fact
 * is the shape detectors weight above any unusual value, and it would land on exactly the profiles that moved
 * country. So the header is spelled out from the same list the init script installs. */
test("Accept-Language spells out the same list the init script installs", () => {
    expect(acceptLanguage(device.languages)).toBe("en-GB,en-US;q=0.9,en;q=0.8");
    // The moved-country case, which is the one this exists for.
    expect(acceptLanguage(["de-DE", "de", "en"])).toBe("de-DE,de;q=0.9,en;q=0.8");
});

// A single-language device is the degenerate case, and a trailing ";q=1.0" on the only entry would be a tell of
// its own: no browser writes one.
test("a one-language device gets a bare header", () => {
    expect(acceptLanguage(["en-US"])).toBe("en-US");
});
