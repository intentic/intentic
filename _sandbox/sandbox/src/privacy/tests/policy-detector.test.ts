import { DEFAULT_PRIVACY_SHIELD, type PrivacyRule, type PrivacyShieldPolicy } from "@intentic/sandbox-contract/schemas/privacy";
import { createMaskMemo, createMasker } from "../masker.js";
import { detectorFor } from "../policy-detector.js";
import { patternRefusal } from "../privacy.routes.js";
import { privacySliceFake } from "../privacy-slice.testing.js";

// The owner's own rules and lists, as every exit of the shield reads them: a term or a pattern is masked wherever it
// stands, as the kind it names; a rule switched off, or whose kind is off, masks nothing, and what it masked before is
// left to it rather than matched by the vault alone.

const rule = (fields: Partial<PrivacyRule> & Pick<PrivacyRule, "id" | "match">): PrivacyRule => ({
    title: fields.id,
    on: true,
    class: "identity-document",
    terms: [],
    pattern: "",
    matchCase: false,
    ...fields,
});

const policyWith = (fields: Partial<PrivacyShieldPolicy>): PrivacyShieldPolicy => ({ ...DEFAULT_PRIVACY_SHIELD, ...fields });

const found = (policy: PrivacyShieldPolicy, text: string): [string, string, string | undefined][] =>
    detectorFor(policy)
        .detect(text)
        .map((span) => [span.value, span.class, span.rule]);

describe("the owner's rules", () => {
    test("a term is found as a whole word in any case, a phrase with its separators anywhere", () => {
        const policy = policyWith({ rules: [rule({ id: "clients", match: "terms", terms: ["Falcon", "Acme Polska"], class: "person-name" })] });
        expect(found(policy, "Project FALCON for acme-polska, not Falconry.")).toEqual([
            ["FALCON", "person-name", "clients"],
            ["acme-polska", "person-name", "clients"],
        ]);
    });

    test("a term with match case is found only as written", () => {
        const policy = policyWith({ rules: [rule({ id: "code", match: "terms", terms: ["Orion"], matchCase: true })] });
        expect(found(policy, "Orion and orion").map(([value]) => value)).toEqual(["Orion"]);
    });

    test("a pattern masks each match, or only its `value` group, ignoring case unless asked", () => {
        const policy = policyWith({
            rules: [
                rule({ id: "emp", match: "pattern", pattern: String.raw`EMP-\d{6}` }),
                rule({ id: "cust", match: "pattern", pattern: String.raw`customer no\. (?<value>\d{4,})`, class: "bank-account" }),
            ],
        });
        expect(found(policy, "emp-123456 wrote about Customer No. 99812 today")).toEqual([
            ["emp-123456", "identity-document", "emp"],
            ["99812", "bank-account", "cust"],
        ]);
        const strict = policyWith({ rules: [rule({ id: "emp", match: "pattern", pattern: String.raw`EMP-\d{6}`, matchCase: true })] });
        expect(found(strict, "emp-123456 EMP-654321").map(([value]) => value)).toEqual(["EMP-654321"]);
    });

    test("a rule switched off, or whose kind is off, finds nothing; an allowed value stays as it is", () => {
        const terms = rule({ id: "t", match: "terms", terms: ["Falcon"] });
        expect(found(policyWith({ rules: [{ ...terms, on: false }] }), "Falcon")).toEqual([]);
        expect(found(policyWith({ rules: [terms], classes: ["email"] }), "Falcon")).toEqual([]);
        expect(found(policyWith({ rules: [terms], allow: ["falcon"] }), "Falcon")).toEqual([]);
    });

    test("where a detector finds the same stretch, the detector's find stands", () => {
        const policy = policyWith({ rules: [rule({ id: "mail", match: "pattern", pattern: String.raw`\S+@\S+\.pl`, class: "email" })] });
        expect(found(policy, "write to jan.nowak@kancelaria-nowak.pl")).toEqual([["jan.nowak@kancelaria-nowak.pl", "email", undefined]]);
    });

    test("a pattern that does not compile is left out and said, not thrown", () => {
        const said: string[] = [];
        const detector = detectorFor(policyWith({ rules: [rule({ id: "bad", match: "pattern", pattern: "(unclosed" })] }), (message) =>
            said.push(message),
        );
        expect(detector.detect("(unclosed")).toEqual([]);
        expect(said.join("\n")).toContain("does not compile");
    });

    test("an own name list is read by the name rules, and a list switched off is not", () => {
        const own = policyWith({
            dictionary: {
                off: [],
                lists: [{ id: "ua", title: "Ukrainian", kind: "first-name", matching: "as-written", words: ["Qwertyna"], on: true }],
            },
        });
        expect(found(own, "Umowę podpisała Qwertyna Nowak.")).toEqual([["Qwertyna Nowak", "person-name", undefined]]);
        expect(found(policyWith({ dictionary: { off: ["surnames-pl"], lists: [] } }), "Dzwoniła Anna Nowak.")).toEqual([]);
    });
});

describe("a rule's finds in the vault", () => {
    test("switching the rule off stops masking what it masked before", async () => {
        const { privacyShield } = privacySliceFake();
        const emp = rule({ id: "emp", match: "pattern", pattern: String.raw`EMP-\d{6}` });
        const on = createMasker({ vault: privacyShield.vault, policy: policyWith({ rules: [emp] }), memo: createMaskMemo() });
        expect((await on.mask("badge EMP-123456")).text).toBe("badge ⟦ID_DOCUMENT_1⟧");
        const off = createMasker({ vault: privacyShield.vault, policy: policyWith({ rules: [{ ...emp, on: false }] }), memo: createMaskMemo() });
        expect((await off.mask("badge EMP-123456 again")).text).toBe("badge EMP-123456 again");
        // Its token still resolves, so what a provider was sent reads back right.
        expect(off.restore("⟦ID_DOCUMENT_1⟧")).toBe("EMP-123456");
    });

    test("a value a detector finds too is matched alone from then on, as the detectors' finds are", async () => {
        const { privacyShield } = privacySliceFake();
        const vault = privacyShield.vault;
        const signer = rule({ id: "signer", match: "terms", terms: ["Qwertyna Nowak"], class: "person-name" });
        const ownList = {
            off: [],
            lists: [{ id: "own", title: "Own", kind: "first-name" as const, matching: "as-written" as const, words: ["Qwertyna"], on: true }],
        };
        await createMasker({ vault, policy: policyWith({ rules: [signer] }), memo: createMaskMemo() }).mask("Qwertyna Nowak signed");
        // Only the rule found it: the vault leaves it to the rule.
        expect(vault.matcher().find("Qwertyna Nowak")).toHaveLength(0);
        // The owner's own first names let the detectors find it too, which makes it one of theirs.
        await createMasker({ vault, policy: policyWith({ dictionary: ownList }), memo: createMaskMemo() }).mask("Qwertyna Nowak again");
        expect(vault.matcher().find("Qwertyna Nowak")).toHaveLength(1);
        const neither = createMasker({ vault, policy: policyWith({}), memo: createMaskMemo() });
        expect((await neither.mask("once more, Qwertyna Nowak")).text).toBe("once more, ⟦PERSON_1⟧");
    });
});

describe("trying the shield", () => {
    test("says what would be masked and what found it, giving no token and keeping nothing", async () => {
        const { privacyShield } = privacySliceFake({
            policy: { rules: [rule({ id: "emp", title: "Badge", match: "pattern", pattern: String.raw`EMP-\d{6}` })] },
        });
        await privacyShield.learn("crm", [{ value: "ACME-0042-XK", class: "identity-document" }]);
        const text = "EMP-123456, ACME-0042-XK and jan@firma.pl";
        const { spans } = await privacyShield.preview(text);
        expect(spans.map((span) => [text.slice(span.start, span.end), span.class, span.by, span.rule])).toEqual([
            ["EMP-123456", "identity-document", "rule", "emp"],
            ["ACME-0042-XK", "identity-document", "learned", undefined],
            ["jan@firma.pl", "email", "detector", undefined],
        ]);
        expect((await privacyShield.vault.counts()).tokens).toBe(1);
    });
});

describe("saving a pattern", () => {
    test("a new or changed pattern is refused with its rule named; one already saved stands", () => {
        const saved = policyWith({ rules: [rule({ id: "old", title: "Old one", match: "pattern", pattern: "(a+)+" })] });
        expect(patternRefusal(saved, saved)).toBeUndefined();
        const next = policyWith({ rules: [...saved.rules, rule({ id: "new", title: "Badge", match: "pattern", pattern: String.raw`(\w+\s?)*!` })] });
        expect(patternRefusal(next, saved)).toContain(`The rule "Badge" can't be saved`);
        expect(patternRefusal(policyWith({ rules: [rule({ id: "e", match: "pattern", pattern: String.raw`\d*` })] }), saved)).toContain(
            "matches empty text",
        );
        expect(patternRefusal(policyWith({ rules: [rule({ id: "t", match: "terms", terms: ["(a+)+"] })] }), saved)).toBeUndefined();
    });
});
