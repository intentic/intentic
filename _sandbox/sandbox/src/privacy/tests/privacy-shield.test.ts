import sharp from "sharp";
import type { OcrLine } from "@intentic/ocr/paddle-ocr";
import { createMaskMemo, createMasker, excerptAround } from "../masker.js";
import { redactStrings } from "../privacy-shield.js";
import type { LocalReaders } from "../readers.js";
import { tokenOf } from "../tokens.js";
import { maskJsonText, restoreJsonText } from "../gateway/protocols/json-text.js";
import { pesel } from "../detect/tests/ids.testing.js";
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

    test("token-shaped text already in a string goes out as an escaped literal, and a string seen before counts nothing new", async () => {
        const { privacyShield } = privacySliceFake();
        const masker = createMasker({ vault: privacyShield.vault, policy: { ...POLICY, classes: [...POLICY.classes] }, memo: createMaskMemo() });
        const first = await masker.mask(`⟦PERSON_7⟧ ma PESEL ${PESEL}`);
        expect(first.text).toBe(`${tokenOf("LITERAL_PERSON", 7)} ma PESEL ${tokenOf("NATIONAL_ID", 1)}`);
        const second = await masker.mask(`⟦PERSON_7⟧ ma PESEL ${PESEL}`);
        expect(second).toEqual({ text: first.text, counts: {}, found: [] });
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

    test("each value found says what it became and how the provider reads the text around it", async () => {
        const { privacyShield } = privacySliceFake();
        const masker = createMasker({ vault: privacyShield.vault, policy: { ...POLICY, classes: ["email"] }, memo: createMaskMemo() });
        const before = "The quarterly report lists every open contract and the person to ask about each one; for the";
        const masked = await masker.mask(
            `${before} renewal write to anna.k@kancelaria-lis.pl before Friday,\n   since   the legal team closes the books then and nothing is signed after.`,
        );
        const token = tokenOf("EMAIL", 1);
        expect(masked.found).toEqual([
            {
                token,
                class: "email",
                excerpt: `…to ask about each one; for the renewal write to ${token} before Friday, since the legal team closes…`,
            },
        ]);
    });

    test("an excerpt is cut at whitespace within reach, and raw where there is none", () => {
        expect(excerptAround("short one", 0, 5)).toBe("short one");
        const text = `${"a".repeat(60)}TOKEN${"b".repeat(60)}`;
        expect(excerptAround(text, 60, 65, 10)).toBe(`…${"a".repeat(10)}TOKEN${"b".repeat(10)}…`);
        expect(excerptAround("one two three TOKEN four five six", 14, 19, 6)).toBe("…three TOKEN four…");
    });

    // A tool call's arguments go out as raw JSON text, where a line break is `\n`: the PESEL after it, new or already in
    // the vault, must be masked all the same, and the arguments must still parse and restore to what the model wrote.
    test("a number right after an escaped line break in a tool call's arguments is masked, new or known", async () => {
        const { privacyShield } = privacySliceFake();
        const masker = createMasker({ vault: privacyShield.vault, policy: { ...POLICY, classes: [...POLICY.classes] }, memo: createMaskMemo() });
        const mask = async (text: string): Promise<string> => (await masker.mask(text)).text;
        const number = pesel(1985, 3, 14, 4562);
        for (const args of [JSON.stringify({ command: `cat <<EOF\n${number}\nEOF` }), JSON.stringify({ o: `x\t${number}` })]) {
            const sent = await maskJsonText(args, mask);
            expect(sent).not.toContain(number);
            expect(restoreJsonText(sent, masker.restore)).toBe(args);
        }
        // Known to the vault by now, and found there the same way after a different escape.
        expect(await mask(JSON.stringify({ o: `y\r${number}` }))).not.toContain(number);
    });

    test("an unknown token is restored to itself, never to a guess", async () => {
        const { privacyShield } = privacySliceFake();
        const masker = createMasker({ vault: privacyShield.vault, policy: { ...POLICY, classes: [...POLICY.classes] }, memo: createMaskMemo() });
        await privacyShield.vault.load();
        expect(masker.restore("⟦PERSON_42⟧ and [[EMAIL_9]]")).toBe("⟦PERSON_42⟧ and [[EMAIL_9]]");
    });

    // A runtime holds only what the gateway restored, so token-shaped text in a request is data: a test fixture, a log the
    // shield wrote, a token pasted from the activity page. Read back by number, an edit that quoted it would no longer
    // match its file, and a write would put somebody's real value where the literal stood.
    test("a token-shaped literal in data comes back as the same literal, never as the vault's value under that number", async () => {
        const { privacyShield } = privacySliceFake();
        const masker = createMasker({ vault: privacyShield.vault, policy: { ...POLICY, classes: [...POLICY.classes] }, memo: createMaskMemo() });
        const name = ["Jan", "Kowalski"].join(" ");
        const seeded = await masker.mask(`Klient ${name} zamówił`);
        const token = tokenOf("PERSON", 1);
        expect(seeded.text).toContain(token);
        // Built rather than written, so it reads as the literal it is.
        const loose = `[[${"PERSON"}_1]]`;
        for (const line of [
            `expect(masked).toBe("${token} ma PESEL");`,
            `in either spelling: ${loose}`,
            `already escaped once: ${tokenOf("LITERAL_PERSON", 1)}`,
        ]) {
            const sent = (await masker.mask(line)).text;
            expect(masker.restore(sent)).toBe(line);
            expect(masker.restore(sent)).not.toContain(name);
            // A model quoting what it read writes back what it was sent, and that too is the literal.
            expect(masker.restore(`old_string: ${sent}`)).toBe(`old_string: ${line}`);
        }
        // A token the shield gave out still reads as its value.
        expect(masker.restore(`Dear ${token}`)).toBe(`Dear ${name}`);
        // A token-shaped literal nothing could resolve goes as it came.
        expect((await masker.mask(`label ${tokenOf("FOO", 3)} here`)).text).toBe(`label ${tokenOf("FOO", 3)} here`);
    });
});

test("the owner reads a token back to its value, in either spelling; a token never given out is left out", async () => {
    const { privacyShield } = privacySliceFake();
    await privacyShield.learn("crm.sqlite:clients (member_no)", [{ value: "ACME-0042-XK", class: "identity-document" }]);
    const token = tokenOf("ID_DOCUMENT", 1);
    // The spelling a model rewrites the brackets into, built rather than written so it reads as what it is.
    const loose = `[[${"ID_DOCUMENT"}_1]]`;
    expect(await privacyShield.reveal([token, loose, tokenOf("PERSON", 9), "not a token"])).toEqual({
        [token]: "ACME-0042-XK",
        [loose]: "ACME-0042-XK",
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

    // Decided by the runtime before a word is read, so the refusal must not read as a finding: it once sent the owner
    // looking for personal data in a message that held none.
    test("a refusal says nothing was read, why the runtime is the reason, and where the way on is", async () => {
        const { privacyShield } = privacySliceFake({ policy: { mode: "on" } });
        const refused = await privacyShield.admit("cursor", "native", "vivid-rowan-moks");
        expect(refused.allowed).toBe(false);
        const reason = refused.allowed ? "" : refused.reason;
        expect(reason).toContain("before reading anything");
        expect(reason).toContain("nothing in what you sent was flagged");
        expect(reason).toContain("Cursor's agent sends what it reads");
        expect(reason).toContain("Let Cursor read this conversation as it is");
        // A helper job has no conversation to grant, so it is not offered one.
        const helper = await privacyShield.admit("cursor", "native");
        expect(helper.allowed ? "" : helper.reason).not.toContain("this conversation");
    });

    test("a grant for one conversation lets the provider run there and nowhere else", async () => {
        const { privacyShield } = privacySliceFake({ policy: { mode: "on", conversations: [{ conversationId: "vivid-rowan-moks", provider: "cursor" }] } });
        expect(await privacyShield.admit("cursor", "native", "vivid-rowan-moks")).toEqual({ allowed: true });
        expect((await privacyShield.admit("cursor", "native", "smart-moth-pq04")).allowed).toBe(false);
        expect((await privacyShield.admit("cursor", "native")).allowed).toBe(false);
        // Granted to one provider, not to whatever the conversation switches to.
        expect((await privacyShield.admit("pi", "native", "vivid-rowan-moks")).allowed).toBe(false);
        // The gateway reads the same grant, so a shieldable provider granted there would be relayed unmasked in it alone.
        const policy = await privacyShield.policy();
        expect(await privacyShield.trusted(policy, "cursor", "vivid-rowan-moks")).toBe(true);
        expect(await privacyShield.trusted(policy, "cursor", "smart-moth-pq04")).toBe(false);
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

    // The trial's base URL goes through the platform tunnel, which listens on loopback: an address that reads as local
    // for a provider whose every request leaves for Intentic's servers and a vendor beyond them.
    test("the free trial reached through the loopback tunnel is still neither local nor trusted", async () => {
        const capabilities = async () => [
            { id: "free-trial", kind: "endpoint", config: { baseUrl: "http://127.0.0.1:41234/trial/v1", protocol: "openai" } } as never,
            { id: "ollama", kind: "endpoint", config: { baseUrl: "http://127.0.0.1:11434/v1", protocol: "openai" } } as never,
        ];
        const { privacyShield } = privacySliceFake({ policy: { mode: "on" }, capabilities });
        const policy = await privacyShield.policy();
        expect(await privacyShield.trusted(policy, "endpoint/free-trial")).toBe(false);
        expect(await privacyShield.trusted(policy, "endpoint/ollama")).toBe(true);
        const providers = (await privacyShield.status()).providers.filter((provider) => provider.id.startsWith("endpoint/"));
        expect(providers.map(({ id, local }) => ({ id, local }))).toEqual([
            { id: "endpoint/free-trial", local: false },
            { id: "endpoint/ollama", local: true },
        ]);
    });
});

test("a page leaving this machine whole carries the kind of data instead of the data, and only while the shield is on", async () => {
    const off = privacySliceFake();
    expect(await off.privacyShield.redactForDisplay(`PESEL ${PESEL}`)).toBe(`PESEL ${PESEL}`);
    const on = privacySliceFake({ policy: { mode: "on" } });
    expect(await on.privacyShield.redactForDisplay(`Jan Kowalski asked about PESEL ${PESEL}`)).toBe("‹person› asked about PESEL ‹national id›");
});

// A public share's payload is walked by redactStrings: a file name or a path can hold the data as well as a message can.
test("a page leaving this machine whole has its paths and names redacted too, while the shield is on", async () => {
    const on = privacySliceFake({ policy: { mode: "on" } });
    const payload = {
        text: `PESEL ${PESEL}`,
        name: `scan-${PESEL}`,
        path: `clients/${PESEL}/scan.png`,
        published: `files/1-${PESEL}.png`,
        locations: [{ path: `clients/${PESEL}.pdf`, line: 3 }],
        attachments: [`files/2-${PESEL}.png`],
        role: "user",
    };
    const redacted = JSON.stringify(await redactStrings(payload, on.privacyShield.redactForDisplay));
    expect(redacted.includes(PESEL)).toBe(false);
    expect(redacted).toContain(`"role":"user"`);
});

// A picture on a public page is painted over as an image sent to an untrusted model is, with the kind of data in place
// of a token, since nothing comes back to resolve one; one that cannot be read is not published at all.
describe("a picture leaving this machine whole", () => {
    const WIDTH = 200;
    const GREY = 128;
    const picture = async (): Promise<Buffer> =>
        sharp({ create: { width: WIDTH, height: 40, channels: 3, background: { r: GREY, g: GREY, b: GREY } } })
            .png()
            .toBuffer();
    const line = (text: string): OcrLine => {
        const chars = [...text];
        return {
            text,
            score: 0.99,
            corners: [
                { x: 0, y: 10 },
                { x: WIDTH, y: 10 },
                { x: WIDTH, y: 30 },
                { x: 0, y: 30 },
            ],
            chars: chars.map((char, index) => ({ char, from: index / chars.length, to: (index + 1) / chars.length })),
            column: 1 / chars.length,
            vertical: false,
        };
    };
    const reading = (text: string): LocalReaders => ({
        ocr: async () => true,
        readImage: async () => ({ width: WIDTH, height: 40, lines: [line(text)] }),
        readPdf: async () => undefined,
    });
    const shadeAt = async (image: Buffer, x: number, y: number): Promise<number> => {
        const { data, info } = await sharp(image).raw().toBuffer({ resolveWithObject: true });
        return data[(y * info.width + x) * info.channels] ?? -1;
    };

    test("has its personal data painted over while the shield is on", async () => {
        const { privacyShield } = privacySliceFake({ policy: { mode: "on" }, readers: reading(`PESEL ${PESEL}`) });
        const out = await privacyShield.redactPictureForDisplay(await picture());
        if (out === undefined) {
            throw new Error("the picture was withheld");
        }
        // The label stays as it was; where the number was is white.
        expect(await shadeAt(out, 10, 20)).toBe(GREY);
        expect(await shadeAt(out, 150, 11)).toBe(255);
    });

    test("is withheld when it cannot be read, and goes as it is while the shield is off", async () => {
        const on = privacySliceFake({ policy: { mode: "on" } });
        expect(await on.privacyShield.redactPictureForDisplay(await picture())).toBeUndefined();
        const off = privacySliceFake({ readers: reading(`PESEL ${PESEL}`) });
        const bytes = await picture();
        expect(await off.privacyShield.redactPictureForDisplay(bytes)).toBe(bytes);
    });
});
