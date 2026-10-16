import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type OrgPolicy, PrivacyShieldPolicySchema, SandboxSettingsSchema } from "@intentic/sandbox-contract";
import { createApp } from "../app.js";
import { clientFor, errorCode } from "../harness/route-client.testing.js";
import { services } from "../harness/route-services.testing.js";
import { createLogger } from "../logger.js";
import { filePrivacyPolicy } from "../privacy/privacy-policy.js";
import { fileSandboxSettingsStore } from "../settings/settings-store.js";
import { testConfig } from "../testing.js";
import { createPinDriftReporter, pinPrivacy, pinSettings, privacyPin, privacyPinRefusal, settingsPin, settingsPinRefusal } from "./org-pins.js";
import { createOrgPolicyHolder } from "../org/org-policy.js";

/* AN ORGANISATION'S PINNED SETTINGS, held on what the daemon READS: a settings file or a privacy policy edited looser
 * outside the routes changes nothing the daemon acts on, is written back pinned, and is recorded once; a save through
 * the routes that would undo a pin is refused; a personal sandbox reads its files as they are. */

const policy = (preset: readonly string[], version = 1): OrgPolicy => ({ orgId: "org-1", orgName: "Urząd Gminy", version, sections: {}, preset: [...preset] });

// A settings file as an agent's shell might leave it: e-mail sends without a hold, transcripts kept forever, no judge.
const LOOSE = SandboxSettingsSchema.parse({
    actionRules: { "imap.message.send": "allow" },
    retention: { transcriptDays: 0 },
    commandJudge: "off",
});

const holder = async (pinned: OrgPolicy | undefined) => {
    const orgPolicy = createOrgPolicyHolder({ authRoot: mkdtempSync(join(tmpdir(), "org-pins-")), logger: createLogger(testConfig) });
    if (pinned !== undefined) {
        await orgPolicy.accept(pinned);
    }
    return orgPolicy;
};

// What the drift reporter recorded, and the reporter.
const drifts = () => {
    const recorded: { readonly document: string; readonly items: readonly string[]; readonly org: string }[] = [];
    return { recorded, report: createPinDriftReporter({ logger: createLogger(testConfig), record: (event) => void recorded.push(event) }) };
};

// The file's own content, re-read until `done` says so or a hang bound passes: the write-back is not awaited by the read.
const settled = async <T>(read: () => T, done: (value: T) => boolean): Promise<T> => {
    for (let attempt = 0; attempt < 200; attempt++) {
        const value = read();
        if (done(value)) {
            return value;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- polling a file another promise writes, with a hang bound
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return read();
};

describe("pinning the preset", () => {
    it("applies only the groups the policy names, never loosens a stricter value, and pins once however often", () => {
        const pinned = pinSettings(LOOSE, policy(["actions", "judge"]));
        expect(pinned.value.actionRules["imap.message.send"]).toBe("hold");
        expect(pinned.value.commandJudge).toBe("on");
        // Retention is not pinned here, so forever stays forever.
        expect(pinned.value.retention.transcriptDays).toBe(0);
        expect(pinned.loosened).toContain("actionRules.imap.message.send");
        expect(pinned.loosened).toContain("commandJudge");
        expect(pinned.loosened).not.toContain("retention.transcriptDays");
        expect(pinSettings(pinned.value, policy(["actions", "judge"])).loosened).toEqual([]);
        // An office that already denies sending keeps its deny.
        const stricter = SandboxSettingsSchema.parse({ actionRules: { "imap.message.send": "deny" } });
        expect(pinSettings(stricter, policy(["actions"])).value.actionRules["imap.message.send"]).toBe("deny");
    });

    it("hands a personal sandbox, and a policy pinning nothing, exactly what it was given", () => {
        expect(pinSettings(LOOSE, undefined)).toMatchObject({ value: LOOSE, loosened: [] });
        expect(pinSettings(LOOSE, policy([]))).toMatchObject({ value: LOOSE, loosened: [] });
        const off = PrivacyShieldPolicySchema.parse({ mode: "off" });
        expect(pinPrivacy(off, undefined, true)).toMatchObject({ value: off, loosened: [] });
    });

    it("pins the privacy shield on, and finds names by the model only where one is installed", () => {
        const off = PrivacyShieldPolicySchema.parse({ mode: "off", images: "allow" });
        const withoutModel = pinPrivacy(off, policy(["privacy"]), false);
        expect(withoutModel.value).toMatchObject({ mode: "on", images: "mask", names: "dictionary" });
        expect(withoutModel.loosened).toEqual(["privacy.mode", "privacy.images"]);
        expect(pinPrivacy(off, policy(["privacy"]), true).value.names).toBe("model");
    });
});

describe("a settings file edited outside the routes", () => {
    it("reads pinned, is written back pinned, and is recorded once", async () => {
        const path = join(mkdtempSync(join(tmpdir(), "org-pins-")), "settings.json");
        writeFileSync(path, JSON.stringify(LOOSE));
        const orgPolicy = await holder(policy(["actions", "retention", "judge"]));
        const { recorded, report } = drifts();
        const store = fileSandboxSettingsStore(path, settingsPin(orgPolicy, report));
        const read = await store.get();
        expect(read.actionRules["imap.message.send"]).toBe("hold");
        expect(read.retention.transcriptDays).toBe(90);
        expect(read.commandJudge).toBe("on");
        // A program that reads the file itself (an extension's CLI) sees the pinned values once the write-back lands.
        const onDisk = await settled(
            () => SandboxSettingsSchema.parse(JSON.parse(readFileSync(path, "utf8"))),
            (file) => file.actionRules["imap.message.send"] === "hold",
        );
        expect(onDisk).toMatchObject({ actionRules: { "imap.message.send": "hold" }, retention: { transcriptDays: 90 }, commandJudge: "on" });
        await store.get();
        expect(recorded).toEqual([
            {
                document: "settings",
                items: expect.arrayContaining(["actionRules.imap.message.send", "retention.transcriptDays", "commandJudge"]),
                org: "Urząd Gminy",
            },
        ]);
    });

    it("stores a write from anywhere but a person's save pinned, and leaves a personal sandbox's file as written", async () => {
        const dir = mkdtempSync(join(tmpdir(), "org-pins-"));
        const bound = fileSandboxSettingsStore(join(dir, "bound.json"), settingsPin(await holder(policy(["judge"])), drifts().report));
        await bound.set(LOOSE);
        expect(JSON.parse(readFileSync(join(dir, "bound.json"), "utf8"))).toMatchObject({ commandJudge: "on" });
        const personal = fileSandboxSettingsStore(join(dir, "personal.json"), settingsPin(await holder(undefined), drifts().report));
        await personal.set(LOOSE);
        expect(JSON.parse(readFileSync(join(dir, "personal.json"), "utf8"))).toMatchObject({ commandJudge: "off" });
        expect((await personal.get()).commandJudge).toBe("off");
    });

    it("takes a new pin the moment the policy carrying it arrives", async () => {
        const path = join(mkdtempSync(join(tmpdir(), "org-pins-")), "settings.json");
        writeFileSync(path, JSON.stringify(LOOSE));
        const orgPolicy = await holder(policy([]));
        const store = fileSandboxSettingsStore(path, settingsPin(orgPolicy, drifts().report));
        expect((await store.get()).commandJudge).toBe("off");
        await orgPolicy.accept(policy(["judge"], 2));
        expect((await store.get()).commandJudge).toBe("on");
    });
});

describe("the privacy shield's policy edited outside the routes", () => {
    it("reads on whatever the file says, and the file follows", async () => {
        const path = join(mkdtempSync(join(tmpdir(), "org-pins-")), "privacy-shield.json");
        writeFileSync(path, JSON.stringify({ mode: "off", images: "allow" }));
        const { recorded, report } = drifts();
        const store = filePrivacyPolicy(path, privacyPin(await holder(policy(["privacy"])), async () => false, report));
        expect(await store.get()).toMatchObject({ mode: "on", images: "mask" });
        const onDisk = await settled(
            () => PrivacyShieldPolicySchema.parse(JSON.parse(readFileSync(path, "utf8"))),
            (file) => file.mode === "on",
        );
        expect(onDisk).toMatchObject({ mode: "on", images: "mask" });
        expect(recorded).toEqual([{ document: "privacy", items: ["privacy.mode", "privacy.images"], org: "Urząd Gminy" }]);
    });
});

describe("a person's save that would undo a pin", () => {
    it("is refused by the settings route and the privacy route, naming the pinned items", async () => {
        const orgPolicy = await holder(policy(["judge", "privacy"]));
        expect(await settingsPinRefusal(orgPolicy, LOOSE)).toMatchObject({ reason: "org-pinned", items: ["commandJudge"], org: "Urząd Gminy" });
        expect(await settingsPinRefusal(orgPolicy, SandboxSettingsSchema.parse({}))).toBeUndefined();
        const off = PrivacyShieldPolicySchema.parse({ mode: "off" });
        expect(await privacyPinRefusal(orgPolicy, off, async () => false)).toMatchObject({ reason: "org-pinned", items: ["privacy.mode"] });
        const client = clientFor(createApp(services({ orgPolicy })));
        expect(await errorCode(client.settings.set(LOOSE))).toBe("FORBIDDEN");
        expect(await errorCode(client.privacy.setPolicy(off))).toBe("FORBIDDEN");
    });

    it("is not refused on a personal sandbox", async () => {
        const orgPolicy = await holder(undefined);
        expect(await settingsPinRefusal(orgPolicy, LOOSE)).toBeUndefined();
        expect(await privacyPinRefusal(orgPolicy, PrivacyShieldPolicySchema.parse({ mode: "off" }), async () => false)).toBeUndefined();
    });

    it("reports a pinned group this daemon does not know instead of refusing the policy", async () => {
        const orgPolicy = await holder(policy(["judge", "biometrics"]));
        expect(await orgPolicy.state()).toMatchObject({ bound: true, unenforced: ["biometrics"] });
        expect(pinSettings(LOOSE, await orgPolicy.current()).value.commandJudge).toBe("on");
    });
});
