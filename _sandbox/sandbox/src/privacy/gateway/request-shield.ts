import { createHash } from "node:crypto";
import type { PrivacyImages } from "@intentic/sandbox-contract";
import type { ClassCounts, Masker } from "../masker.js";
import type { LocalReaders } from "../readers.js";
import type { RequestShield, ShieldBinary, ShieldTally } from "./shield-types.js";

// The shield one request is walked with: the masker for text, the local readers for images and PDFs, and the note that
// tells the model what a token is. Masking builds the body that leaves; watching builds the same tally over a body that
// leaves untouched, and never pays to read an image.

// Appended to the instructions of every masked request, worded the same every time so the provider's prompt cache keeps.
// Its examples spell the number as a letter: a real one would be a token the vault may have given somebody.
export const SHIELD_NOTE =
    "Personal data in this conversation (names, identity and tax numbers, accounts, contact details, addresses) reaches you as tokens of the form ⟦PERSON_n⟧ or ⟦NATIONAL_ID_n⟧ (n a number), and each token is turned back into the real value on the user's machine before anything runs or is shown. Treat a token as the value it stands for: write it exactly as given, brackets, label and number, wherever that value belongs, in replies, commands, code and file edits alike. Never guess, reconstruct or ask for the values behind tokens.";

const WITHHELD_IMAGE =
    "[An image was withheld by the privacy shield: this model provider is not trusted with personal data, and the image could not be checked for it on this machine. If you need to see it, say so and the user can switch this conversation to a trusted model.]";
const WITHHELD_DOCUMENT =
    "[A document was withheld by the privacy shield: this model provider is not trusted with personal data, and the document's text could not be read on this machine to mask it. If you need it, say so and the user can switch this conversation to a trusted model.]";
const READ_IMAGE = "[An image, replaced by its text as read on the user's machine, with personal data masked by the privacy shield:]";
const READ_DOCUMENT = "[A document, replaced by its text as read on the user's machine, with personal data masked by the privacy shield:]";

const addCounts = (into: Record<string, number>, counts: ClassCounts): void => {
    for (const [kind, count] of Object.entries(counts)) {
        into[kind] = (into[kind] ?? 0) + (count ?? 0);
    }
};

export const emptyTally = (): ShieldTally => ({ counts: {}, images: 0, documents: 0 });

// Readings by content hash: a screenshot re-sent with every request of a turn is read once.
export interface ReadingMemo {
    readonly get: (key: string) => string | undefined | null;
    readonly set: (key: string, text: string | undefined) => void;
}

// Few and small: a reading is a page of text, and the same handful of images recur within a conversation.
export const createReadingMemo = (limit = 256): ReadingMemo => {
    const entries = new Map<string, string | undefined>();
    return {
        // `null` is a miss; `undefined` remembers that the reader found nothing.
        get: (key) => (entries.has(key) ? entries.get(key) : null),
        set: (key, text) => {
            entries.set(key, text);
            if (entries.size > limit) {
                const oldest = entries.keys().next().value;
                if (oldest !== undefined) {
                    entries.delete(oldest);
                }
            }
        },
    };
};

const PDF = /^application\/pdf\b/iu;

export interface RequestShieldDeps {
    readonly masker: Masker;
    readonly readers: LocalReaders;
    readonly readings: ReadingMemo;
    readonly images: PrivacyImages;
    readonly tally: ShieldTally;
}

export const maskingShield = ({ masker, readers, readings, images, tally }: RequestShieldDeps): RequestShield => {
    const mask = async (text: string): Promise<string> => {
        const result = await masker.mask(text);
        addCounts(tally.counts, result.counts);
        return result.text;
    };
    const remembered = async (binary: ShieldBinary, read: (data: Buffer) => Promise<string | undefined>): Promise<string | undefined> => {
        const key = createHash("sha1").update(binary.mediaType).update("\0").update(binary.data).digest("base64url");
        const hit = readings.get(key);
        if (hit !== null) {
            return hit;
        }
        const text = await read(Buffer.from(binary.data, "base64"));
        readings.set(key, text);
        return text;
    };
    return {
        mask,
        note: SHIELD_NOTE,
        image: async (image) => {
            if (images === "allow") {
                return "keep";
            }
            tally.images += 1;
            if (images === "withhold" || image.mediaType === "url") {
                return { text: WITHHELD_IMAGE };
            }
            const text = await remembered(image, readers.readImage);
            return text === undefined ? { text: WITHHELD_IMAGE } : { text: `${READ_IMAGE}\n${await mask(text)}` };
        },
        document: async (document) => {
            tally.documents += 1;
            if (document.mediaType === "url" || !PDF.test(document.mediaType)) {
                return { text: WITHHELD_DOCUMENT };
            }
            const text = await remembered(document, readers.readPdf);
            return text === undefined ? { text: WITHHELD_DOCUMENT } : { text: `${READ_DOCUMENT}\n${await mask(text)}` };
        },
    };
};

// Watch mode: the same tally, nothing replaced, nothing read. The body built with it is thrown away.
export const watchingShield = ({ masker, tally, images }: Pick<RequestShieldDeps, "masker" | "tally" | "images">): RequestShield => ({
    mask: async (text) => {
        const result = await masker.mask(text);
        addCounts(tally.counts, result.counts);
        return text;
    },
    note: undefined,
    image: async () => {
        // What masking would have done to it: an allowed image would have gone as it is, and counts for nothing.
        if (images !== "allow") {
            tally.images += 1;
        }
        return "keep";
    },
    document: async () => {
        tally.documents += 1;
        return "keep";
    },
});
