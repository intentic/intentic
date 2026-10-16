import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PRIVACY_SHIELD, type PrivacyShieldPolicy } from "@intentic/sandbox-contract/schemas/privacy";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../composition.js";
import { createLogger } from "../logger.js";
import { filePrivacyPolicy, privacyShieldDocument } from "../privacy/privacy-policy.js";
import { packFragment } from "../image/packs.js";
import { privacyPackFragments, privacyPackWanted } from "./privacy-pack.js";
import { createOrgPolicyHolder } from "../org/org-policy.js";
import { createPinDriftReporter, type Pin, privacyPin } from "../compliance/org-pins.js";

/* The privacy pack rides the overlay exactly when the shield's policy asks for one of its readers. */

const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });

// The shield's policy as the shield reads it: the file in `authRoot`, through a bound sandbox's pins when `pin` is given.
const services = (authRoot: string, pin?: Pin<PrivacyShieldPolicy>): Pick<Services, "privacyShield" | "logger"> =>
    unstubbed<Services>("services", {
        logger,
        privacyShield: unstubbed("privacyShield", { policy: () => filePrivacyPolicy(join(authRoot, privacyShieldDocument.path), pin).get() }),
    });

const withPolicy = (policy: Partial<PrivacyShieldPolicy> | string): string => {
    const authRoot = mkdtempSync(join(tmpdir(), "privacy-pack-"));
    const body = typeof policy === "string" ? policy : JSON.stringify({ ...DEFAULT_PRIVACY_SHIELD, ...policy });
    writeFileSync(join(authRoot, privacyShieldDocument.path), body);
    return authRoot;
};

const privacyPack = async (): Promise<string[]> => [await packFragment("privacy")].filter((fragment) => fragment !== undefined);

test("the default policy wants no readers: the shield is off", () => {
    expect(privacyPackWanted(DEFAULT_PRIVACY_SHIELD)).toBe(false);
});

test("a shield that is off wants no readers, whatever its reader settings", () => {
    expect(privacyPackWanted({ ...DEFAULT_PRIVACY_SHIELD, mode: "off", images: "mask", names: "model" })).toBe(false);
});

test("on or watching, masking images or finding names by model each want the pack", () => {
    for (const mode of ["on", "watch"] as const) {
        expect(privacyPackWanted({ ...DEFAULT_PRIVACY_SHIELD, mode })).toBe(true);
        expect(privacyPackWanted({ ...DEFAULT_PRIVACY_SHIELD, mode, images: "allow", names: "model" })).toBe(true);
        expect(privacyPackWanted({ ...DEFAULT_PRIVACY_SHIELD, mode, images: "allow", names: "dictionary" })).toBe(false);
    }
});

test("no policy written: nothing rides the overlay", async () => {
    expect(await privacyPackFragments(services(mkdtempSync(join(tmpdir(), "privacy-pack-"))))).toEqual([]);
});

test("a policy masking images brings the privacy pack", async () => {
    expect(await privacyPackFragments(services(withPolicy({ mode: "on", images: "mask" })))).toEqual(await privacyPack());
});

test("a policy written before images were masked converts and still brings the pack", async () => {
    expect(await privacyPackFragments(services(withPolicy(JSON.stringify({ mode: "watch", images: "read" }))))).toEqual(await privacyPack());
});

test("an unreadable policy leaves the pack out instead of failing the compose", async () => {
    expect(await privacyPackFragments(services(withPolicy("{half a jso")))).toEqual([]);
});

test("a shield an organisation pins on brings the pack even when the file says off", async () => {
    const authRoot = withPolicy({ mode: "off" });
    const orgPolicy = createOrgPolicyHolder({ authRoot: mkdtempSync(join(tmpdir(), "privacy-pack-org-")), logger });
    await orgPolicy.accept({ orgId: "org-1", orgName: "Urząd Gminy", version: 1, sections: {}, preset: ["privacy"] });
    const pin = privacyPin(orgPolicy, async () => false, createPinDriftReporter({ logger, record: () => {} }));
    expect(await privacyPackFragments(services(authRoot, pin))).toEqual(await privacyPack());
});
