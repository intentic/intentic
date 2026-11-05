import type { TranscriptRow } from "@intentic/sandbox-contract/events/transcript";
import { DEFAULT_PRIVACY_SHIELD, type PrivacyShieldPolicy } from "@intentic/sandbox-contract/schemas/privacy";
import type { PrivacyHardening } from "@intentic/sandbox-contract/schemas/privacy-leaks";
import type { OrpcContext } from "../../app-env.js";
import { turnProof } from "../../seams/workload-stamp.js";
import { measureHardening, withHardening } from "../leaks/hardening.js";
import { labelBefore, outlineOf } from "../leaks/leak-outline.js";
import { fieldSuspects } from "../leaks/leak-scan.js";
import {
    applyProposal,
    judgeLeak,
    type LeaksDeps,
    leakSource,
    leaksView,
    measureLeakHardening,
    proposeHardening,
    reportLeak,
    scanLeaks,
} from "../leaks/leaks-service.js";
import { detectorFor } from "../policy-detector.js";
import { type RevealDeps, revealer } from "../privacy.routes.js";
import { privacySliceFake } from "../privacy-slice.testing.js";

// Leaks and the hardening against them: a reported value is masked from then on, an untrusted reader never reads one,
// a scan suspects what stands under a personal field unmasked, and a proposal is measured against the leaks and recent
// text, then written into the policy only by the owner's apply.

const ROW = (text: string): TranscriptRow => ({ role: "user", text });

// A record as the test document had it: a passport number whose check digit fails and an address on a reserved domain,
// both skipped by the detectors on purpose, under labels that say what they are.
const RECORD = [
    "## 01 Aleksandra Wilk",
    "| **PESEL** | 84031410003 | **NIP** | 526-100-00-07 |",
    "| **Nr paszportu** | AB8100000 | **Telefon** | +48 501 284 117 |",
    "| **E-mail** | aleksandra.wilk@example.com | **Typ karty** | Visa |",
].join("\n");

const OTHER = "| **Nr paszportu** | AC8106317 |\nZamówienie 2024-118-554, wersja 4.12.7.";

const standUp = (policy: Partial<PrivacyShieldPolicy> = { mode: "on" }) => {
    const slice = privacySliceFake({ policy });
    const deps: LeaksDeps = {
        shield: slice.privacyShield,
        store: slice.privacyLeaks,
        conversations: () => [
            { id: "c1", updatedAt: 2 },
            { id: "c2", updatedAt: 1 },
        ],
        rows: async (id) => (id === "c1" ? [ROW(RECORD)] : [ROW(OTHER)]),
        now: () => new Date("2026-11-05T10:00:00Z"),
    };
    return { slice, deps };
};

const PASSPORT_RULE: PrivacyHardening = {
    rules: [
        {
            title: "Passport under its label",
            class: "identity-document",
            match: "pattern",
            pattern: String.raw`(?:paszport\p{L}*)[*\s|:]+(?<value>[A-Z]{2}\d{7})`,
            terms: [],
            matchCase: false,
        },
    ],
    lists: [],
};

describe("outlines", () => {
    test("a value is its letters' case and its digits, nothing of itself", () => {
        expect(outlineOf("AB8100000")).toBe("AA9999999");
        expect(outlineOf("aleksandra.wilk@example.com")).toBe("aaaaaaaaaa.aaaa@aaaaaaa.aaa");
        expect(outlineOf("Aleksandra Wilk")).toBe("Aaaaaaaaaa Aaaa");
    });

    test("the label is the cell before, and a word that could be a name is written as its outline", () => {
        const lexicon = detectorFor(DEFAULT_PRIVACY_SHIELD).lexicon;
        const text = "| **Nr paszportu** | AB8100000 |";
        expect(labelBefore(text, text.indexOf("AB"), lexicon)).toBe("Nr paszportu");
        const named = "Kowalski Jan: AB8100000";
        expect(labelBefore(named, named.indexOf("AB"), lexicon)).toBe("Aaaaaaaa Aaa");
    });
});

describe("the scan", () => {
    test("suspects a value under a personal field, and not a card's type under a card's label", () => {
        const found = fieldSuspects(RECORD).map((suspect) => [suspect.class, suspect.value]);
        expect(found).toContainEqual(["identity-document", "AB8100000"]);
        expect(found).toContainEqual(["email", "aleksandra.wilk@example.com"]);
        expect(found.some(([, value]) => value === "Visa")).toBe(false);
    });

    test("keeps only what nothing masks, as suspected, and teaches nothing", async () => {
        const { slice, deps } = standUp();
        const result = await scanLeaks(deps, 5);
        expect(result.conversations).toBe(2);
        const leaks = (await deps.store.read()).leaks;
        const values = leaks.map((leak) => leak.value);
        expect(values).toContain("AB8100000");
        expect(values).toContain("AC8106317");
        // The PESEL and the phone are masked by the detectors already.
        expect(values).not.toContain("84031410003");
        expect(leaks.every((leak) => leak.state === "suspected" && leak.origin === "scan")).toBe(true);
        expect(await slice.privacyShield.sources()).toEqual([]);
        // A second scan suggests nothing it already kept.
        expect((await scanLeaks(deps, 5)).suspected).toBe(0);
    });
});

describe("a reported leak", () => {
    test("is masked from then on, so no request carries it again", async () => {
        const { slice, deps } = standUp();
        const leak = await reportLeak(deps, { value: "AB8100000", class: "identity-document", context: RECORD, conversationId: "c1" });
        expect(leak.state).toBe("confirmed");
        expect(leak.context).toContain("AB8100000");
        const masker = await slice.privacyShield.masker(await slice.privacyShield.policy());
        const masked = await masker.mask("Please check passport AB8100000 again.");
        expect(masked.text).not.toContain("AB8100000");
        expect(masked.text).toContain("⟦ID_DOCUMENT_");
    });

    test("an untrusted reader reads its outline and label, never its value or the text around it", async () => {
        const { deps } = standUp();
        await reportLeak(deps, { value: "AB8100000", class: "identity-document", context: RECORD });
        const hidden = await leaksView(deps, false);
        const serialized = JSON.stringify(hidden);
        expect(serialized).not.toContain("AB8100000");
        expect(serialized).not.toContain("Wilk");
        expect(hidden.leaks[0]).toMatchObject({ outline: "AA9999999", label: "Nr paszportu", caught: "no" });
        const shown = await leaksView(deps, true);
        expect(shown.leaks[0]?.value).toBe("AB8100000");
    });

    test("dismissed, its taught value is forgotten", async () => {
        const { slice, deps } = standUp();
        const leak = await reportLeak(deps, { value: "AB8100000", class: "identity-document" });
        expect((await slice.privacyShield.sources()).map((source) => source.source)).toEqual([leakSource(leak.id)]);
        await judgeLeak(deps, leak.id, "dismissed");
        expect(await slice.privacyShield.sources()).toEqual([]);
    });
});

describe("hardening", () => {
    test("a rule is measured against the confirmed leaks and the recent text, the values only for a reader who may read them", async () => {
        const { deps } = standUp();
        await reportLeak(deps, { value: "AB8100000", class: "identity-document", context: RECORD });
        const measured = await measureLeakHardening(deps, PASSPORT_RULE, false);
        expect(measured.leaks).toEqual({ total: 1, before: 0, after: 1, missed: [] });
        // The other passport in recent text is one more value it masks; the leak's own value is not counted.
        expect(measured.control.added).toBe(1);
        expect(measured.control.samples[0]).toMatchObject({ class: "identity-document", outline: "AA9999999" });
        expect(JSON.stringify(measured)).not.toContain("AC8106317");
        expect((await measureLeakHardening(deps, PASSPORT_RULE, true)).control.samples[0]?.value).toBe("AC8106317");
    });

    test("a pattern that could hold the daemon is refused at the proposal", async () => {
        const { deps } = standUp();
        const nested: PrivacyHardening = { rules: [{ ...PASSPORT_RULE.rules[0]!, pattern: "(a+)+b" }], lists: [] };
        await expect(proposeHardening(deps, { title: "Bad", why: "", hardening: nested }, undefined)).rejects.toThrow(/nested repeat/);
    });

    test("a word named by its leak goes on the owner's list when the proposal is applied, and the rule is switched on", async () => {
        const { slice, deps } = standUp();
        const leak = await reportLeak(deps, { value: "Aleksandra Wilk", class: "person-name" });
        const { id } = await proposeHardening(
            deps,
            {
                title: "Passports and surnames",
                why: "",
                hardening: { ...PASSPORT_RULE, lists: [{ title: "Our surnames", kind: "surname", matching: "inflected", words: [], fromLeaks: [{ leak: leak.id, word: 1 }] }] },
            },
            "c9",
        );
        const view = await leaksView(deps, true);
        expect(view.words[`${leak.id}:1`]).toBe("Wilk");
        expect((await leaksView(deps, false)).words).toEqual({});
        await applyProposal(deps, id, slice.privacyShield.setPolicy);
        const policy = await slice.privacyShield.policy();
        expect(policy.rules.map((rule) => [rule.id, rule.on])).toEqual([[`${id.toLowerCase()}-r1`, true]]);
        expect(policy.dictionary.lists.map((list) => [list.title, list.kind, list.words])).toEqual([["Our surnames", "surname", ["Wilk"]]]);
        expect((await deps.store.read()).proposals).toEqual([]);
    });

    test("words go onto the owner's list of the same title and kind rather than a second one", () => {
        const policy: PrivacyShieldPolicy = {
            ...DEFAULT_PRIVACY_SHIELD,
            dictionary: { off: [], lists: [{ id: "mine", title: "Our surnames", kind: "surname", matching: "as-written", words: ["Kot"], on: true }] },
        };
        const next = withHardening(policy, { rules: [], lists: [{ title: "our surnames", kind: "surname", matching: "inflected", words: ["kot", "Lis"], fromLeaks: [] }] }, () => undefined, "p1");
        expect(next.dictionary.lists).toEqual([{ id: "mine", title: "Our surnames", kind: "surname", matching: "as-written", words: ["Kot", "Lis"], on: true }]);
    });

    test("a rule matching ordinary text shows up as values it would mask", async () => {
        const greedy: PrivacyHardening = { rules: [{ ...PASSPORT_RULE.rules[0]!, title: "Any number", pattern: String.raw`\d{4}` }], lists: [] };
        const measured = await measureHardening({ policy: { ...DEFAULT_PRIVACY_SHIELD, mode: "on" }, hardening: greedy, leaks: [], control: [OTHER], reveal: false });
        expect(measured.control.added).toBeGreaterThan(1);
    });
});

describe("who reads values", () => {
    const shieldOn = (trusted: readonly string[]) => privacySliceFake({ policy: { mode: "on", trusted: [...trusted] } }).privacyShield;
    const services = (trusted: readonly string[]): RevealDeps => ({
        privacyShield: shieldOn(trusted),
        agents: { entry: (id: string) => (id === "c1" ? { profile: { provider: "claude" } } : undefined) },
    });
    const context = (headers: Record<string, string>): OrpcContext => ({ headers: new Headers(headers), method: "GET", url: "/privacy/leaks" });
    const agent = (conversation: string, proof = turnProof(conversation)) =>
        context({ "x-intentic-agent": "token", "x-intentic-conversation": conversation, "x-intentic-turn-proof": proof });

    test("a person who runs the shield does", async () => {
        expect(await revealer(services([]))(context({}))).toBe(true);
    });

    test("an agent on a trusted provider does, on an untrusted one does not", async () => {
        expect(await revealer(services(["claude"]))(agent("c1"))).toBe(true);
        expect(await revealer(services([]))(agent("c1"))).toBe(false);
    });

    test("an agent that cannot prove its conversation does not", async () => {
        expect(await revealer(services(["claude"]))(agent("c1", "forged"))).toBe(false);
        expect(await revealer(services(["claude"]))(context({ "x-intentic-agent": "token" }))).toBe(false);
    });
});

