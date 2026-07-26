import { expect, test } from "vitest";
import { SandboxSettingsSchema } from "./schemas.js";

/* The settings shape spans a version seam that really moves: the browser ships with the platform, the daemon
 * ships inside the user's sandbox image, so a web build routinely parses a payload from an OLDER daemon. These
 * tests pin the property that makes that survivable — an absent key is that flag's default, not a parse
 * failure — because failing instead reaches the user as a settings page whose switches silently do nothing. */

test("a payload from a build that predates a toggle parses, with the new toggle at its default", () => {
    // What a daemon built before the output-cleaner backend switch answers with: every key it knew, and
    // nothing for the one added after it shipped.
    const older = {
        stableSystemPrompt: false,
        skills: [],
        hashlineEdits: false,
        terseOutput: true,
        iqSearch: true,
        outputCleaners: "-cap",
        outputHoldout: 0.1,
    };
    expect(SandboxSettingsSchema.parse(older)).toEqual({ ...older, filterBackend: "native" });
});

test("an empty object is the full default settings object", () => {
    expect(SandboxSettingsSchema.parse({})).toEqual({
        stableSystemPrompt: false,
        skills: [],
        hashlineEdits: false,
        terseOutput: false,
        iqSearch: false,
        outputCleaners: "off",
        outputHoldout: 0,
        filterBackend: "native",
    });
});

test("a key of the wrong type is still a parse failure — tolerance is for absence, not for garbage", () => {
    expect(SandboxSettingsSchema.safeParse({ iqSearch: "yes" }).success).toBe(false);
    expect(SandboxSettingsSchema.safeParse({ outputHoldout: 4 }).success).toBe(false);
});
