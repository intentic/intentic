import { inflateRawSync } from "node:zlib";
import { DEFAULT_PRIVACY_SHIELD, type PrivacyShieldPolicy } from "@intentic/sandbox-contract/schemas/privacy";
import type { Measure } from "@intentic/sandbox-contract/schemas/compliance";
import { type SandboxSettings, SandboxSettingsSchema } from "@intentic/sandbox-contract/schemas/settings";
import { documentFilename, renderDocument } from "./drafts.js";
import { markdownToDocx } from "./docx.js";
import type { ComplianceFacts } from "./facts.js";
import { applyPreset, PRESET_ITEM_IDS, type PresetState, presetPreview, PUBLIC_OFFICE_ACTION_KEYS } from "./preset.js";
import { flowsOf, measuresOf, reportOf } from "./report.js";

// Pins the data protection page's mapping: what a default sandbox and a preset-applied one report, that the preset
// proposes and applies only what is named and never loosens anything, that nothing about it moves a default, and that
// the documents carry the office's blanks.

const defaults = (): SandboxSettings => SandboxSettingsSchema.parse({});

// A representative self-hosted sandbox: Claude connected, a local model, a Discord bot an automation listens on, an
// IMAP mailbox, a GitHub connector, one web chat, reached through Intentic's tunnel.
const factsWith = (settings: SandboxSettings, privacy: PrivacyShieldPolicy = DEFAULT_PRIVACY_SHIELD): ComplianceFacts => ({
    settings,
    privacy,
    readers: { ocr: true, model: false },
    providers: [
        { id: "claude", label: "Claude Code", shieldable: true, local: false, connected: true },
        { id: "codex", label: "Codex", shieldable: true, local: false, connected: false },
        { id: "endpoint/llama", label: "llama", shieldable: true, local: true, connected: true },
    ],
    endpoints: [{ id: "llama", kind: "localmodel", baseUrl: undefined, model: "bielik" }],
    connectors: [
        { id: "discord", provider: "discord", hosts: [], guarded: false, host: undefined },
        { id: "mail", provider: "imap", hosts: [], guarded: false, host: "imap.urzad.gov.pl" },
        { id: "github", provider: "github", hosts: ["api.github.com"], guarded: true, host: undefined },
    ],
    listening: ["discord"],
    webchats: [{ id: "chat", enabled: true, aiDisclosure: true, turnstile: false, googleSignIn: false }],
    browsers: 0,
    speechCloud: undefined,
    platform: { url: "https://api.intentic.dev", state: "registered" },
    ingress: { by: "tunnel", ingressUrl: "https://ingress.sbx.intentic.dev", publicUrl: "https://abc.sbx.intentic.dev" },
    updateChecks: true,
    pushChannels: 0,
    members: { total: 3, guests: 0, fenced: 0, emailSignIn: 0 },
    areas: 0,
    agentDomain: "root",
    credentialGates: 0,
    hostGuards: 1,
    atRestKey: false,
    version: "1.2.3",
});

const state = (settings: SandboxSettings = defaults(), privacy: PrivacyShieldPolicy = DEFAULT_PRIVACY_SHIELD, nameModel = false): PresetState => ({
    settings,
    privacy,
    nameModel,
});

const statusOf = (measures: readonly Measure[], id: Measure["id"]): Measure["status"] | undefined => measures.find((measure) => measure.id === id)?.status;

describe("defaults", () => {
    it("keep earlier policies except the thirty-day restore-point window", () => {
        const settings = defaults();
        expect(settings.retention).toEqual({ transcriptDays: 0, restorePointKeepDays: 30, privacyVaultDays: 0, cacheDays: 0, rawOutputDays: 0 });
        expect(settings.audit.recordReads).toBe(false);
        expect(settings.productAnalytics).toBe(true);
        expect(settings.aiNotice.show).toBe(false);
        expect(settings.actionRules).toEqual({});
        expect(settings.admission.webchat).toBe("allow");
        expect(settings.commandJudge).toBe("on");
        expect(DEFAULT_PRIVACY_SHIELD.mode).toBe("off");
    });

    it("reading the preset leaves the state as it was", () => {
        const before = state();
        const snapshot = structuredClone(before);
        presetPreview(before);
        expect(before).toEqual(snapshot);
    });
});

describe("flows", () => {
    it("lists a default sandbox's paths with the shield off", () => {
        const flows = flowsOf(factsWith(defaults()));
        const claude = flows.find((flow) => flow.id === "model-provider:claude");
        expect(claude).toMatchObject({ hosts: ["api.anthropic.com"], personalData: "yes", shield: "none", thirdCountry: true, active: true });
        // Not connected, so not a path.
        expect(flows.some((flow) => flow.id === "model-provider:codex")).toBe(false);
        expect(flows.find((flow) => flow.id === "local-model:llama")).toMatchObject({ shield: "local", thirdCountry: false });
        expect(flows.find((flow) => flow.kind === "team-chat")).toMatchObject({ hosts: expect.arrayContaining(["discord.com"]), shield: "none" });
        expect(flows.find((flow) => flow.kind === "email-imap")).toMatchObject({ hosts: ["imap.urzad.gov.pl"] });
        // No SMTP host on the card: it reads mail and sends none.
        expect(flows.find((flow) => flow.kind === "email-smtp")).toBeUndefined();
        expect(flows.find((flow) => flow.kind === "connector")).toMatchObject({ name: "github", hosts: ["api.github.com"] });
        expect(flows.find((flow) => flow.id === "product-analytics")).toMatchObject({ active: true, switch: "productAnalytics" });
        expect(flows.find((flow) => flow.id === "ingress")).toMatchObject({ active: true, operator: "Intentic (Fly.io)", question: "ingress-region" });
        expect(flows.find((flow) => flow.id === "update-check")).toMatchObject({ active: true, personalData: "no", hosts: expect.arrayContaining(["ghcr.io", "api.github.com"]) });
    });

    it("masks untrusted providers, passes trusted ones and refuses unreadable runtimes once the shield is on", () => {
        const privacy = { ...DEFAULT_PRIVACY_SHIELD, mode: "on" as const, trusted: ["claude"] };
        const facts = factsWith(defaults(), privacy);
        expect(flowsOf(facts).find((flow) => flow.id === "model-provider:claude")?.shield).toBe("trusted");
        const unreadable = { ...facts, providers: [{ id: "pi", label: "Pi", shieldable: false, local: false, connected: true }] };
        expect(flowsOf(unreadable).find((flow) => flow.id === "model-provider:pi")?.shield).toBe("blocked");
        expect(flowsOf({ ...facts, privacy: { ...privacy, trusted: [] } }).find((flow) => flow.id === "model-provider:claude")?.shield).toBe("masked");
    });

    it("asks how the sandbox is reached when there is neither a tunnel nor an address of the office's own", () => {
        const facts = factsWith(defaults());
        const local = flowsOf({ ...facts, ingress: { by: "loopback", ingressUrl: "", publicUrl: "" } }).find((flow) => flow.id === "ingress");
        expect(local).toMatchObject({ active: false, question: "ingress-proxy" });
        const proxied = flowsOf({ ...facts, ingress: { by: "loopback", ingressUrl: "", publicUrl: "https://ai.urzad.gov.pl" } }).find((flow) => flow.id === "ingress");
        expect(proxied).toMatchObject({ active: true, hosts: ["ai.urzad.gov.pl"], question: undefined });
    });
});

describe("measures", () => {
    it("reads a default sandbox as mostly available but off", () => {
        const measures = measuresOf(factsWith(defaults()));
        expect(statusOf(measures, "privacy-shield")).toBe("off");
        expect(statusOf(measures, "retention")).toBe("partial");
        expect(statusOf(measures, "audit-reads")).toBe("off");
        expect(statusOf(measures, "product-analytics")).toBe("off");
        expect(statusOf(measures, "ai-notice")).toBe("off");
        expect(statusOf(measures, "action-rules")).toBe("off");
        expect(statusOf(measures, "command-judge")).toBe("on");
        expect(statusOf(measures, "local-models")).toBe("on");
        expect(statusOf(measures, "host-guards")).toBe("on");
        expect(statusOf(measures, "encryption-at-rest")).toBe("off");
        expect(statusOf(measures, "encryption-in-transit")).toBe("on");
        expect(statusOf(measures, "webchat-ai-disclosure")).toBe("on");
        expect(statusOf(measures, "backups")).toBe("unknown");
    });

    it("reads the preset-applied sandbox as in place", () => {
        const applied = applyPreset(state(), PRESET_ITEM_IDS, true);
        const facts = factsWith(applied.settings, applied.privacy);
        const measures = measuresOf(facts);
        for (const id of ["privacy-shield", "privacy-images", "retention", "audit-reads", "product-analytics", "ai-notice", "action-rules", "admission", "command-judge"] as const) {
            expect([id, statusOf(measures, id)]).toEqual([id, "on"]);
        }
        // The name model is not installed, so names stay found by the dictionary alone.
        expect(statusOf(measures, "privacy-names")).toBe("partial");
        const flows = flowsOf(facts);
        expect(flows.find((flow) => flow.id === "model-provider:claude")?.shield).toBe("masked");
        expect(flows.find((flow) => flow.id === "product-analytics")?.active).toBe(false);
    });
});

describe("preset", () => {
    it("proposes each stricter value beside the current one, every item selectable", () => {
        const items = presetPreview(state());
        expect(items.find((item) => item.id === "privacy.mode")).toMatchObject({ current: "off", proposed: "on", changes: true, owner: true });
        // Already the default.
        expect(items.find((item) => item.id === "privacy.images")).toMatchObject({ current: "mask", proposed: "mask", changes: false });
        expect(items.find((item) => item.id === "privacy.names")).toMatchObject({ available: false });
        expect(items.find((item) => item.id === "retention.transcriptDays")).toMatchObject({ current: 0, proposed: 90 });
        expect(items.find((item) => item.id === "audit.retentionDays")).toMatchObject({ current: 365, proposed: 730 });
        expect(items.find((item) => item.id === "productAnalytics")).toMatchObject({ current: true, proposed: false });
        expect(items.find((item) => item.id === "actionRules.discord.message.send")).toMatchObject({ current: null, proposed: "hold" });
        expect(items.find((item) => item.id === "admission.webchat")).toMatchObject({ current: "allow", proposed: "hold" });
        // Already hold by default.
        expect(items.find((item) => item.id === "admission.issues")).toMatchObject({ changes: false });
        expect(items.filter((item) => item.id.startsWith("actionRules."))).toHaveLength(PUBLIC_OFFICE_ACTION_KEYS.length);
        expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
    });

    it("applies only the items named", () => {
        const before = state();
        const outcome = applyPreset(before, ["retention.transcriptDays", "actionRules.agents.spawn"], true);
        expect(outcome.applied).toEqual(["retention.transcriptDays", "actionRules.agents.spawn"]);
        expect(outcome.settings).toEqual({
            ...before.settings,
            retention: { ...before.settings.retention, transcriptDays: 90 },
            actionRules: { "agents.spawn": "hold" },
        });
        expect(outcome.privacy).toBe(before.privacy);
        expect(outcome.privacyChanged).toBe(false);
        expect(outcome.settingsChanged).toBe(true);
    });

    it("skips what it cannot or need not apply, and says why", () => {
        const outcome = applyPreset(state(), ["privacy.names", "privacy.images", "nonsense", "privacy.mode"], false);
        expect(outcome.applied).toEqual([]);
        expect(outcome.skipped).toEqual([
            { id: "privacy.names", reason: "unavailable" },
            { id: "privacy.images", reason: "owner" },
            { id: "nonsense", reason: "unknown" },
            { id: "privacy.mode", reason: "owner" },
        ]);
        expect(applyPreset(state(), ["privacy.names"], true).skipped).toEqual([{ id: "privacy.names", reason: "unavailable" }]);
        expect(applyPreset(state(), ["privacy.images"], true).skipped).toEqual([{ id: "privacy.images", reason: "unchanged" }]);
        expect(applyPreset(state(undefined, undefined, true), ["privacy.names"], true).privacy.names).toBe("model");
    });

    it("never loosens what is already stricter", () => {
        const strict = SandboxSettingsSchema.parse({
            retention: { transcriptDays: 7 },
            audit: { retentionDays: 1000 },
            actionRules: { "discord.*": "deny", "agents.spawn": "deny" },
            admission: { webchat: "deny" },
        });
        const items = presetPreview(state(strict));
        expect(items.find((item) => item.id === "retention.transcriptDays")).toMatchObject({ current: 7, proposed: 7, changes: false });
        expect(items.find((item) => item.id === "audit.retentionDays")).toMatchObject({ proposed: 1000, changes: false });
        expect(items.find((item) => item.id === "actionRules.discord.message.send")).toMatchObject({ current: "deny", proposed: "deny", changes: false });
        expect(items.find((item) => item.id === "actionRules.agents.spawn")).toMatchObject({ changes: false });
        expect(items.find((item) => item.id === "admission.webchat")).toMatchObject({ proposed: "deny", changes: false });
    });

    it("leaves nothing to change once every item is applied", () => {
        const first = applyPreset(state(undefined, undefined, true), PRESET_ITEM_IDS, true);
        const again = presetPreview(state(first.settings, first.privacy, true));
        expect(again.filter((item) => item.changes)).toEqual([]);
        expect(applyPreset(state(first.settings, first.privacy, true), PRESET_ITEM_IDS, true).applied).toEqual([]);
    });
});

describe("documents", () => {
    const report = reportOf(factsWith(defaults()), new Date("2026-10-13T09:00:00Z"));
    const facts = factsWith(defaults());

    it("drafts the record of processing in Polish with the office's blanks and the recipients the configuration knows", () => {
        const text = renderDocument(facts, report, "ropa", "pl");
        expect(text).toContain("Rejestr czynności przetwarzania");
        expect(text).toContain("Projekt przygotowany automatycznie 2026-10-13");
        expect(text).toContain("**[✎ DO UZUPEŁNIENIA: nazwa urzędu, adres, e-mail]**");
        expect(text).toContain("Kategorie osób, których dane dotyczą");
        expect(text).toContain("Anthropic PBC (api.anthropic.com)");
        expect(text).toContain("Przekazanie danych do państwa trzeciego");
        // A local model is no recipient.
        expect(text).not.toContain("Model AI uruchomiony lokalnie:");
        expect(text).toContain("bez limitu (przechowywane bezterminowo)");
    });

    it("drafts the impact assessment with the risks, their configured mitigations and the AI Act note", () => {
        const text = renderDocument(facts, report, "dpia", "pl");
        expect(text).toContain("Ocena skutków dla ochrony danych");
        expect(text).toContain("art. 22 RODO");
        expect(text).toContain("Osłona prywatności (dostępne, niewłączone)");
        expect(text).toContain("załącznik III pkt 5 lit. a");
        const english = renderDocument(facts, report, "dpia", "en");
        expect(english).toContain("Annex III, point 5(a)");
        expect(english).toContain("**[✎ TO BE COMPLETED:");
    });

    it("lists the measures by category with where each is changed", () => {
        const text = renderDocument(facts, report, "toms", "en");
        expect(text).toContain("## Confidentiality");
        expect(text).toContain("Sandbox ▸ Privacy shield");
        expect(text).toContain("Backups");
        expect(documentFilename("toms", "pl")).toBe("srodki-techniczne-i-organizacyjne");
    });

    it("packs a Word document whose body holds the text", () => {
        const bytes = markdownToDocx(renderDocument(facts, report, "ropa", "pl"));
        expect(bytes.subarray(0, 4).toString("binary")).toBe("PK\u0003\u0004");
        // Walk the local headers to word/document.xml and inflate it.
        let offset = 0;
        let xml = "";
        while (bytes.readUInt32LE(offset) === 0x04034b50) {
            const size = bytes.readUInt32LE(offset + 18);
            const nameLength = bytes.readUInt16LE(offset + 26);
            const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
            const data = bytes.subarray(offset + 30 + nameLength, offset + 30 + nameLength + size);
            if (name === "word/document.xml") {
                xml = inflateRawSync(data).toString("utf8");
            }
            offset += 30 + nameLength + size;
        }
        expect(xml).toContain("Rejestr czynności przetwarzania");
        expect(xml).toContain(`<w:highlight w:val="yellow"/>`);
        expect(xml).toContain("<w:tbl>");
    });
});

describe("a mailbox that can also send", () => {
    it("adds the SMTP server as a way out of its own, gated by the action rules", () => {
        const facts = factsWith(defaults());
        const connectors = facts.connectors.map((connector) =>
            connector.provider === "imap" ? { ...connector, smtpHost: "smtp.urzad.gov.pl" } : connector,
        );
        const smtp = flowsOf({ ...facts, connectors }).find((flow) => flow.kind === "email-smtp");
        expect(smtp).toMatchObject({ hosts: ["smtp.urzad.gov.pl"], switch: "actionRules", personalData: "yes" });
    });

    it("holds the e-mail send key the IMAP sender reads", () => {
        expect(PUBLIC_OFFICE_ACTION_KEYS).toContain("imap.message.send");
    });

    it("holds every outward action key the Microsoft 365 CLI reads", () => {
        expect(PUBLIC_OFFICE_ACTION_KEYS).toEqual(expect.arrayContaining(["microsoft365.mail.send", "microsoft365.calendar.write", "microsoft365.files.upload"]));
    });

    it("holds every office act the e-urzad gate reads", () => {
        expect(PUBLIC_OFFICE_ACTION_KEYS).toEqual(
            expect.arrayContaining([
                "ezdrp.document.register-incoming",
                "ezdrp.document.register-outgoing",
                "ezdrp.case.attach-draft",
                "edoreczenia.delivery.send",
                "edoreczenia.delivery.open",
            ]),
        );
    });
});
