import { createHash } from "node:crypto";
import type { PrivacyImages } from "@intentic/sandbox-contract";
import { type PaintedImage, paintRegions, readingText, regionsFor } from "../image-mask.js";
import type { ClassCounts, Masker } from "../masker.js";
import type { ImageReading, LocalReaders } from "../readers.js";
import type { RequestShield, ShieldBinary, ShieldTally } from "./shield-types.js";

// The shield one request is walked with: the masker for text, the local readers for images and PDFs, and the note that
// tells the model what a token is. Masking builds the body that leaves; watching builds the same tally over a body that
// leaves untouched, and never pays to read an image.

// Appended to the instructions of every masked request, worded the same every time so the provider's prompt cache keeps.
// Its examples spell the number as a letter: a real one would be a token the vault may have given somebody.
export const SHIELD_NOTE =
    "Personal data in this conversation (names, identity and tax numbers, accounts, contact details, addresses) reaches you as tokens of the form ⟦PERSON_n⟧ or ⟦NATIONAL_ID_n⟧ (n a number), and each token is turned back into the real value on the user's machine before anything runs or is shown. In images, the personal data is painted over with its token in black on white. Treat a token as the value it stands for: write it exactly as given, brackets, label and number, wherever that value belongs, in replies, commands, code and file edits alike. Never guess, reconstruct or ask for the values behind tokens.";

const WITHHELD_IMAGE =
    "[An image was withheld by the privacy shield: this model provider is not trusted with personal data, and the image could not be read on this machine to cover the personal data in it. If you need to see it, say so and the user can switch this conversation to a trusted model.]";
const WITHHELD_DOCUMENT =
    "[A document was withheld by the privacy shield: this model provider is not trusted with personal data, and the document's text could not be read on this machine to mask it. If you need it, say so and the user can switch this conversation to a trusted model.]";
const READ_DOCUMENT = "[A document, replaced by its text as read on the user's machine, with personal data masked by the privacy shield:]";

const addCounts = (into: Record<string, number>, counts: ClassCounts): void => {
    for (const [kind, count] of Object.entries(counts)) {
        into[kind] = (into[kind] ?? 0) + (count ?? 0);
    }
};

export const emptyTally = (): ShieldTally => ({ counts: {}, images: 0, documents: 0 });

// Values by content hash, oldest dropped first: a screenshot re-sent with every request of a turn is read once.
export interface Memo<T> {
    // `null` is a miss; `undefined` remembers that there was nothing.
    readonly get: (key: string) => T | undefined | null;
    readonly set: (key: string, value: T | undefined) => void;
}

const createMemo = <T>(limit: number): Memo<T> => {
    const entries = new Map<string, T | undefined>();
    return {
        get: (key) => (entries.has(key) ? entries.get(key) : null),
        set: (key, value) => {
            entries.set(key, value);
            if (entries.size > limit) {
                const oldest = entries.keys().next().value;
                if (oldest !== undefined) {
                    entries.delete(oldest);
                }
            }
        },
    };
};

// What the readers produced, kept across the requests of every conversation: documents' text, images' lines, and the
// masked images themselves, so a re-sent image goes out as the same bytes and the provider's prompt cache keeps.
export interface ReadingMemo {
    readonly texts: Memo<string>;
    readonly images: Memo<ImageReading>;
    readonly painted: Memo<PaintedImage>;
}

// Few and small, except the painted images: those are whole pictures, so fewer of them are kept.
export const createReadingMemo = (limit = 256): ReadingMemo => ({
    texts: createMemo(limit),
    images: createMemo(limit),
    painted: createMemo(Math.max(1, Math.floor(limit / 8))),
});

const PDF = /^application\/pdf\b/iu;

// An image a request names by its address, fetched here so what is checked is what is sent. Bounded in size and time.
const IMAGE_FETCH_LIMIT = 20 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 15_000;

export const fetchRemoteImage = async (url: string, send: typeof fetch = fetch): Promise<ShieldBinary | undefined> => {
    if (!/^https?:\/\//iu.test(url)) {
        return undefined;
    }
    try {
        const response = await send(url, { signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS), redirect: "follow" });
        const type = response.headers.get("content-type") ?? "";
        const length = Number(response.headers.get("content-length") ?? "0");
        if (!response.ok || !type.toLowerCase().startsWith("image/") || length > IMAGE_FETCH_LIMIT) {
            return undefined;
        }
        const bytes = Buffer.from(await response.arrayBuffer());
        return bytes.byteLength > IMAGE_FETCH_LIMIT ? undefined : { mediaType: type.split(";")[0]?.trim() ?? type, data: bytes.toString("base64") };
    } catch {
        // allow(silent-catch): an image that cannot be fetched cannot be checked, which the caller answers by holding it back.
        return undefined;
    }
};

export interface RequestShieldDeps {
    readonly masker: Masker;
    readonly readers: LocalReaders;
    readonly readings: ReadingMemo;
    readonly images: PrivacyImages;
    readonly tally: ShieldTally;
    // Where an image named by its address is fetched from; the network unless a test says otherwise.
    readonly fetchImage?: (url: string) => Promise<ShieldBinary | undefined>;
}

const keyOf = (binary: ShieldBinary): string => createHash("sha1").update(binary.mediaType).update("\0").update(binary.data).digest("base64url");

export const maskingShield = ({ masker, readers, readings, images, tally, fetchImage = fetchRemoteImage }: RequestShieldDeps): RequestShield => {
    const mask = async (text: string): Promise<string> => {
        const result = await masker.mask(text);
        addCounts(tally.counts, result.counts);
        return result.text;
    };
    // The memo's answer, or the reader's, remembered; `fresh` when the reader ran, so a re-sent image counts once.
    const remembered = async <T>(memo: Memo<T>, binary: ShieldBinary, read: (data: Buffer) => Promise<T | undefined>) => {
        const key = keyOf(binary);
        const hit = memo.get(key);
        if (hit !== null) {
            return { key, value: hit, fresh: false };
        }
        const value = await read(Buffer.from(binary.data, "base64"));
        memo.set(key, value);
        return { key, value, fresh: true };
    };
    // The image with what the reader found painted over, or the note that holds it back when it could not be read.
    const maskImage = async (source: ShieldBinary): Promise<"keep" | { readonly text: string } | { readonly image: ShieldBinary }> => {
        const reading = await remembered(readings.images, source, readers.readImage);
        if (reading.value === undefined) {
            tally.images += reading.fresh ? 1 : 0;
            return { text: WITHHELD_IMAGE };
        }
        const found = await masker.find(readingText(reading.value.lines));
        addCounts(tally.counts, found.counts);
        if (found.spans.length === 0) {
            return "keep";
        }
        const regions = regionsFor(reading.value.lines, found.spans, reading.value);
        const paintKey = createHash("sha1").update(reading.key).update("\0").update(JSON.stringify(regions)).digest("base64url");
        let painted = readings.painted.get(paintKey);
        if (painted === null) {
            painted = await paintRegions(Buffer.from(source.data, "base64"), regions);
            readings.painted.set(paintKey, painted);
        }
        tally.images += reading.fresh ? 1 : 0;
        return painted === undefined ? { text: WITHHELD_IMAGE } : { image: painted };
    };
    return {
        mask,
        note: SHIELD_NOTE,
        image: async (image) => {
            if (images === "allow") {
                return "keep";
            }
            if (image.mediaType !== "url") {
                return maskImage(image);
            }
            // By address, the image is fetched and checked here and goes inline, masked or not: what the provider would
            // have fetched itself could differ from what was checked.
            const fetched = await fetchImage(image.data);
            if (fetched === undefined) {
                tally.images += 1;
                return { text: WITHHELD_IMAGE };
            }
            const verdict = await maskImage(fetched);
            return verdict === "keep" ? { image: fetched } : verdict;
        },
        document: async (document) => {
            tally.documents += 1;
            if (document.mediaType === "url" || !PDF.test(document.mediaType)) {
                return { text: WITHHELD_DOCUMENT };
            }
            const { value: text } = await remembered(readings.texts, document, readers.readPdf);
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
