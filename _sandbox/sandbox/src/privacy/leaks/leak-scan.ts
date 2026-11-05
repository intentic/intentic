import type { TranscriptRow, TranscriptTool } from "@intentic/sandbox-contract/events/transcript";
import type { PersonalDataClass, PrivacyPreviewSpan } from "@intentic/sandbox-contract/schemas/privacy";
import type { EntityRecognizer } from "../masker.js";

// The scan for leaks, run on this machine over recent conversations: what was sent that nothing masks but looks like
// personal data anyway. Two finders, both looser than the shield on purpose, since what they find is only suspected and
// the owner judges each: the local name model (where the privacy pack installed it), and a value under a field whose
// label says what it holds (`PESEL: …`, `| Nr paszportu | … |`, `E-mail: …`). The second is what finds the values a
// detector skips by design (a test number whose checksum fails, an address on a reserved domain) when they stand where
// data stands, and the owner says whether this sandbox's data is like that.

export interface Suspect {
    readonly start: number;
    readonly end: number;
    readonly value: string;
    readonly class: PersonalDataClass;
    readonly why: string;
}

// Field labels, each with the kind its value is. Matched as whole words, in any case, before a colon, an equals sign, a
// tab or a table cell's bar.
const LABELS: readonly { readonly kind: PersonalDataClass; readonly label: string }[] = [
    { kind: "national-id", label: String.raw`pesel|ssn|social security(?: number)?|national id(?: number)?` },
    { kind: "tax-id", label: String.raw`nip|tax id|tin|vat(?: id| number)?` },
    { kind: "identity-document", label: String.raw`(?:nr |numer )?paszport\p{L}*|(?:nr |numer )?dowod\p{L}*(?: osobist\p{L}*)?|dowód\p{L}*(?: osobist\p{L}*)?|passport(?: no\.?| number)?|id card(?: number)?|identity card|document number` },
    { kind: "phone", label: String.raw`telefon\p{L}*|tel\.?|phone(?: number)?|mobile|komórk\p{L}*` },
    { kind: "email", label: String.raw`e-?mail|adres e-?mail` },
    { kind: "bank-account", label: String.raw`iban|nrb|rachun\p{L}*(?: bankow\p{L}*)?(?: \(iban\))?|konto(?: bankowe)?|(?:bank )?account(?: number)?` },
    { kind: "payment-card", label: String.raw`(?:nr |numer )?kart\p{L}*(?: płatnicz\p{L}*| kredytow\p{L}*)?|(?:credit |payment )?card(?: number)?` },
    { kind: "address", label: String.raw`adres\p{L}*(?: korespondencyjn\p{L}*| pocztow\p{L}*| zamieszkania)?|address|ulica|street` },
    { kind: "person-name", label: String.raw`imi[eę] i nazwisko|imi[eę]|nazwisko|full name|first name|last name|surname|given name|family name` },
];

// The label, then emphasis, a separator (`:`, `=`, a tab, or a cell's bar), and the value up to the end of its cell or line.
const FIELD = new RegExp(
    String.raw`(?<![\p{L}\p{N}])(?<label>${LABELS.map(({ label }) => `(?:${label})`).join("|")})[*_]*[ \t]*(?:[:=]|\t|\|)[ \t]*[*_]*[ \t]*(?<value>[^|\n]{2,120}?)[ \t]*[*_]*[ \t]*(?=\||\n|$)`,
    "giu",
);

const DIGITS = /\p{N}/gu;
const digitCount = (value: string): number => value.match(DIGITS)?.length ?? 0;
const NAME_WORD = /^\p{Lu}[\p{Ll}'’-]+$/u;

// Whether a value under a label looks like what the label says: a card's type is no card number, "brak" no PESEL.
const plausible = (kind: PersonalDataClass, value: string): boolean => {
    switch (kind) {
        case "national-id":
        case "tax-id":
        case "bank-account":
        case "payment-card":
        case "phone":
            return digitCount(value) >= 6;
        case "identity-document":
            return digitCount(value) >= 4 && value.replace(/\s/gu, "").length <= 20;
        case "email":
            return /^[^\s@]+@[^\s@]+\.[\p{L}]{2,}$/u.test(value);
        case "address":
            return digitCount(value) >= 1 && /\p{L}{3}/u.test(value);
        case "person-name": {
            const words = value.split(/\s+/u);
            return words.length >= 1 && words.length <= 4 && words.every((word) => NAME_WORD.test(word));
        }
    }
};

const kindOfLabel = (label: string): PersonalDataClass | undefined =>
    LABELS.find(({ label: pattern }) => new RegExp(`^(?:${pattern})$`, "iu").test(label))?.kind;

// A token the shield already gave, or text holding one: masked already.
const TOKENISH = /⟦|\[\[[A-Z_]+_\d+\]\]/u;

export const fieldSuspects = (text: string): Suspect[] => {
    const found: Suspect[] = [];
    for (const match of text.matchAll(FIELD)) {
        const label = match.groups?.["label"] ?? "";
        const raw = match.groups?.["value"] ?? "";
        const value = raw.trim();
        const kind = kindOfLabel(label);
        if (kind === undefined || TOKENISH.test(value) || !plausible(kind, value)) {
            continue;
        }
        const start = match.index + match[0].lastIndexOf(raw) + (raw.length - raw.trimStart().length);
        found.push({ start, end: start + value.length, value, class: kind, why: `under a field labelled "${label.trim()}"` });
    }
    return found;
};

// What the name model reads as a name or an address, as suspects.
export const modelSuspects = async (text: string, recognizer: EntityRecognizer): Promise<Suspect[]> =>
    (await recognizer.find(text))
        .filter((span) => !TOKENISH.test(span.value))
        .map((span) => ({ start: span.start, end: span.end, value: span.value, class: span.class, why: "the local name model reads it as personal data" }));

const covered = (spans: readonly Pick<PrivacyPreviewSpan, "start" | "end">[], suspect: Suspect): boolean =>
    spans.some((span) => Math.min(span.end, suspect.end) - Math.max(span.start, suspect.start) >= (suspect.end - suspect.start) / 2);

// The suspects in one text that nothing the shield runs (its detectors, lists, rules and the vault) masks: `masked` is
// where the shield finds something in it. One per value and kind.
export const leaksIn = (suspects: readonly Suspect[], masked: readonly Pick<PrivacyPreviewSpan, "start" | "end">[]): Suspect[] => {
    const seen = new Set<string>();
    return suspects
        .toSorted((left, right) => left.start - right.start)
        .filter((suspect) => {
            const key = `${suspect.class}\u0000${suspect.value.toLowerCase()}`;
            if (covered(masked, suspect) || seen.has(key)) {
                return false;
            }
            seen.add(key);
            return true;
        });
};

const toolText = (tool: TranscriptTool): string[] => [
    ...(tool.input === undefined ? [] : [tool.input]),
    ...(tool.content ?? []).flatMap((item) => (item.type === "text" ? [item.text] : [])),
    ...(tool.children ?? []).flatMap(toolText),
];

// What a conversation sent and was sent, as text: every message and every tool's input and output as the record holds them.
export const transcriptText = (rows: readonly TranscriptRow[], max: number): string => {
    let text = "";
    for (const row of rows) {
        for (const piece of [row.text, ...(row.tools ?? []).flatMap(toolText)]) {
            if (piece.trim() !== "") {
                text += `${piece}\n\n`;
            }
            if (text.length >= max) {
                return text.slice(0, max);
            }
        }
    }
    return text;
};
