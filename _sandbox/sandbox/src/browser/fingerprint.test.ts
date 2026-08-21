import { expect, test } from "vitest";
import type { BrowserFingerprint } from "./fingerprint.js";
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
