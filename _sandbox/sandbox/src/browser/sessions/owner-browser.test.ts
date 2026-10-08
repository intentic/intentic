import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { seedPreferences } from "./owner-browser.js";

// What a window's profile holds before Chromium starts on it: the fingerprint's languages, and no translate offer to
// cover the picture. Whatever else the person set stays theirs.

const profiles: string[] = [];
afterAll(() => {
    for (const dir of profiles) {
        rmSync(dir, { recursive: true, force: true });
    }
});

// A profile directory, with a Preferences file holding `prefs` written as given (a string is written raw).
const profileWith = (raw?: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "owner-prefs-"));
    profiles.push(dir);
    if (raw !== undefined) {
        mkdirSync(join(dir, "Default"), { recursive: true });
        writeFileSync(join(dir, "Default", "Preferences"), raw);
    }
    return dir;
};

const preferencesOf = (dir: string) => z.looseObject({}).parse(JSON.parse(readFileSync(join(dir, "Default", "Preferences"), "utf8")));

test("a fresh profile gets the languages and no translate offer", async () => {
    const fresh = profileWith();
    await seedPreferences(fresh, ["pl-PL", "pl", "en"]);
    expect(preferencesOf(fresh)).toEqual({
        intl: { accept_languages: "pl-PL,pl,en", selected_languages: "pl-PL,pl,en" },
        translate: { enabled: false },
    });
});

test("a used profile keeps everything the person set beside them", async () => {
    const used = profileWith(JSON.stringify({ intl: { accept_languages: "en", other: 1 }, translate: { enabled: true, keep: "x" }, session: { restore_on_startup: 1 } }));
    await seedPreferences(used, ["en-US", "en"]);
    expect(preferencesOf(used)).toEqual({
        intl: { accept_languages: "en-US,en", selected_languages: "en-US,en", other: 1 },
        translate: { enabled: false, keep: "x" },
        session: { restore_on_startup: 1 },
    });
});

test("a Preferences file it cannot read is left for Chromium", async () => {
    for (const raw of ["{not json", JSON.stringify({ intl: "not a section" })]) {
        const broken = profileWith(raw);
        // oxlint-disable-next-line eslint/no-await-in-loop -- two files, one at a time
        await seedPreferences(broken, ["en"]);
        expect(readFileSync(join(broken, "Default", "Preferences"), "utf8")).toBe(raw);
    }
});
