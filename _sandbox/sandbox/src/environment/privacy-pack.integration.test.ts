import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PRIVACY_SHIELD, type PrivacyShieldPolicy } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../composition.js";
import { createLogger } from "../logger.js";
import { privacyShieldDocument } from "../privacy/privacy-policy.js";
import { packFragment } from "./packs.js";
import { privacyPackFragments, privacyPackWanted } from "./privacy-pack.js";

/* The privacy pack rides the overlay exactly when the shield's policy asks for one of its readers. */

const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });

const services = (authRoot: string): Pick<Services, "authRoot" | "logger"> => unstubbed<Services>("services", { authRoot, logger });

const withPolicy = (policy: Partial<PrivacyShieldPolicy> | string): string => {
    const authRoot = mkdtempSync(join(tmpdir(), "privacy-pack-"));
    const body = typeof policy === "string" ? policy : JSON.stringify({ ...DEFAULT_PRIVACY_SHIELD, ...policy });
    writeFileSync(join(authRoot, privacyShieldDocument.path), body);
    return authRoot;
};

const privacyPack = async (): Promise<string[]> => [await packFragment("privacy")].filter((fragment) => fragment !== undefined);

test("the default policy wants no readers", () => {
    expect(privacyPackWanted(DEFAULT_PRIVACY_SHIELD)).toBe(false);
});

test("a shield that is off wants no readers, whatever its reader settings", () => {
    expect(privacyPackWanted({ ...DEFAULT_PRIVACY_SHIELD, mode: "off", images: "read", names: "model" })).toBe(false);
});

test("on or watching, reading images or finding names by model each want the pack", () => {
    for (const mode of ["on", "watch"] as const) {
        expect(privacyPackWanted({ ...DEFAULT_PRIVACY_SHIELD, mode, images: "read" })).toBe(true);
        expect(privacyPackWanted({ ...DEFAULT_PRIVACY_SHIELD, mode, names: "model" })).toBe(true);
        expect(privacyPackWanted({ ...DEFAULT_PRIVACY_SHIELD, mode, images: "withhold", names: "dictionary" })).toBe(false);
    }
});

test("no policy written: nothing rides the overlay", async () => {
    expect(await privacyPackFragments(services(mkdtempSync(join(tmpdir(), "privacy-pack-"))))).toEqual([]);
});

test("a policy reading images to text brings the privacy pack", async () => {
    expect(await privacyPackFragments(services(withPolicy({ mode: "on", images: "read" })))).toEqual(await privacyPack());
});

test("an unreadable policy leaves the pack out instead of failing the compose", async () => {
    expect(await privacyPackFragments(services(withPolicy("{half a jso")))).toEqual([]);
});
