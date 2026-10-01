import { createMaskMemo, createMasker } from "../masker.js";
import { privacySliceFake } from "../privacy-slice.testing.js";

// The parts of the shield every exit shares: the masker the gateway walks a request with, the decision whether a turn
// may run at all, and the redaction a page or a notification leaving this machine whole gets.

const PESEL = "44051401458";
const POLICY = { classes: ["person-name", "national-id", "email"] as const, allow: [] as string[], names: "dictionary" as const };

describe("the masker", () => {
    test("a found value becomes a token, and restoring gives back exactly what was masked", async () => {
        const { privacyShield } = privacySliceFake();
        const masker = createMasker({ vault: privacyShield.vault, policy: { ...POLICY, classes: [...POLICY.classes] }, memo: createMaskMemo() });
        const text = `Klient Jan Kowalski, PESEL ${PESEL}, pisze z jan.kowalski@firma.pl`;
        const masked = await masker.mask(text);
        expect(masked.text).not.toContain(PESEL);
        expect(masked.text).not.toContain("jan.kowalski@firma.pl");
        expect(masked.counts["national-id"]).toBe(1);
        expect(masker.restore(masked.text)).toBe(text);
    });

    test("a taught value is masked where no detector would know it for what it is", async () => {
        const { privacyShield } = privacySliceFake();
        // A customer number in the owner's own format, which no pattern describes.
        await privacyShield.learn("crm.sqlite:clients (member_no)", [{ value: "ACME-0042-XK", class: "identity-document" }]);
        const masker = createMasker({ vault: privacyShield.vault, policy: { ...POLICY, classes: ["identity-document"] }, memo: createMaskMemo() });
        expect((await masker.mask("member ACME-0042-XK renewed")).text).toBe("member ⟦ID_DOCUMENT_1⟧ renewed");
    });

    test("tokens already in a string are left exactly as they are, and a string seen before counts nothing new", async () => {
        const { privacyShield } = privacySliceFake();
        const masker = createMasker({ vault: privacyShield.vault, policy: { ...POLICY, classes: [...POLICY.classes] }, memo: createMaskMemo() });
        const first = await masker.mask(`⟦PERSON_7⟧ ma PESEL ${PESEL}`);
        expect(first.text).toBe("⟦PERSON_7⟧ ma PESEL ⟦NATIONAL_ID_1⟧");
        const second = await masker.mask(`⟦PERSON_7⟧ ma PESEL ${PESEL}`);
        expect(second).toEqual({ text: first.text, counts: {} });
    });

    test("an allowed value and a switched-off kind are left as they are", async () => {
        const { privacyShield } = privacySliceFake();
        const masker = createMasker({
            vault: privacyShield.vault,
            policy: { classes: ["national-id"], allow: ["Jan Kowalski"], names: "dictionary" },
            memo: createMaskMemo(),
        });
        const masked = await masker.mask(`Jan Kowalski, jan@firma.pl, ${PESEL}`);
        expect(masked.text).toBe("Jan Kowalski, jan@firma.pl, ⟦NATIONAL_ID_1⟧");
    });

    test("an unknown token is restored to itself, never to a guess", async () => {
        const { privacyShield } = privacySliceFake();
        const masker = createMasker({ vault: privacyShield.vault, policy: { ...POLICY, classes: [...POLICY.classes] }, memo: createMaskMemo() });
        await privacyShield.vault.load();
        expect(masker.restore("⟦PERSON_42⟧ and [[EMAIL_9]]")).toBe("⟦PERSON_42⟧ and [[EMAIL_9]]");
    });
});

describe("whether a turn may run", () => {
    test("off or watching, every runtime runs", async () => {
        for (const mode of ["off", "watch"] as const) {
            const { privacyShield } = privacySliceFake({ policy: { mode } });
            expect(await privacyShield.admit("cursor", "native")).toEqual({ allowed: true });
        }
    });

    test("on, a runtime the gateway covers runs whatever its provider, and one it cannot runs only if trusted", async () => {
        const { privacyShield } = privacySliceFake({ policy: { mode: "on" } });
        expect(await privacyShield.admit("claude", "native")).toEqual({ allowed: true });
        expect(await privacyShield.admit("codex", "native")).toEqual({ allowed: true });
        expect(await privacyShield.admit("gemini", "native")).toEqual({ allowed: true });
        expect((await privacyShield.admit("cursor", "native")).allowed).toBe(false);
        expect((await privacyShield.admit("my-acp-agent", "native")).allowed).toBe(false);
        expect((await privacyShield.admit("pi", "native")).allowed).toBe(false);
        const trusting = privacySliceFake({ policy: { mode: "on", trusted: ["cursor"] } });
        expect(await trusting.privacyShield.admit("cursor", "native")).toEqual({ allowed: true });
    });

    test("a model this machine serves is trusted whatever the list says, and the free trial never is", async () => {
        const { privacyShield } = privacySliceFake({
            policy: { mode: "on" },
            capabilities: async () => [
                { id: "qwen", kind: "localmodel", config: { model: "qwen", file: "q.gguf", contextSize: 8192 } } as never,
                { id: "free-trial", kind: "endpoint", config: { baseUrl: "https://platform.intentic.dev/trial", protocol: "openai" } } as never,
            ],
        });
        const policy = await privacyShield.policy();
        expect(await privacyShield.trusted(policy, "endpoint/qwen")).toBe(true);
        expect(await privacyShield.trusted(policy, "endpoint/free-trial")).toBe(false);
    });
});

test("a page leaving this machine whole carries the kind of data instead of the data, and only while the shield is on", async () => {
    const off = privacySliceFake();
    expect(await off.privacyShield.redactForDisplay(`PESEL ${PESEL}`)).toBe(`PESEL ${PESEL}`);
    const on = privacySliceFake({ policy: { mode: "on" } });
    expect(await on.privacyShield.redactForDisplay(`Jan Kowalski asked about PESEL ${PESEL}`)).toBe("‹person› asked about PESEL ‹national id›");
});
