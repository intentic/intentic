import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PersonalDataSpan } from "./detect/detect.js";
import type { EntityRecognizer } from "./masker.js";

// The local name model behind `names: "model"`: a Polish named-entity model (HerBERT fine-tuned for personal data, from
// the `privacy` image pack) that finds the names a dictionary misses, a rare surname, a foreign one, a name in an odd
// inflection. It runs on this machine, offline, like iq's embedder; without the pack the dictionary is all there is.
//
// The pipeline transformers.js ships drops character offsets, so the text is split into words here and each word is
// tokenized on its own: a word's label is its first piece's, and a run of person-labelled words is one span with exact
// offsets. HerBERT's tokenizer marks word ends, so a word tokenized alone gives the pieces it would get in context.

export const NER_MODEL_ID = "herbert-ner-pl";
export const nerModelDir = (): string => process.env["PRIVACY_NER_MODEL_DIR"] ?? "/opt/privacy-models";

export const nerInstalled = (dir: string = nerModelDir()): boolean => existsSync(join(dir, NER_MODEL_ID, "config.json"));

// BERT's own limit is 512 pieces with its two markers; words are packed into windows below it.
const WINDOW_PIECES = 480;
// Below this the model is guessing; a name it is unsure of is the dictionary's to find.
const MIN_SCORE = 0.6;
const WORD = /[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu;
const CAPITALIZED = /\p{Lu}/u;

interface Word {
    readonly start: number;
    readonly end: number;
    readonly pieces: readonly number[];
}

interface Tokenizer {
    readonly encode: (text: string, options: { add_special_tokens: boolean }) => number[];
    readonly cls_token_id?: number;
    readonly sep_token_id?: number;
}

interface LogitsTensor {
    readonly data: Float32Array;
    readonly dims: readonly number[];
}

type Model = (inputs: Record<string, unknown>) => Promise<{ logits: LogitsTensor }>;
type TensorConstructor = new (type: string, data: BigInt64Array, dims: number[]) => unknown;

const softmaxMax = (row: Float32Array): { index: number; score: number } => {
    let best = 0;
    for (let i = 1; i < row.length; i += 1) {
        if ((row[i] ?? -Infinity) > (row[best] ?? -Infinity)) {
            best = i;
        }
    }
    const top = row[best] ?? 0;
    let sum = 0;
    for (const value of row) {
        sum += Math.exp(value - top);
    }
    return { index: best, score: 1 / sum };
};

const windowsOf = (words: readonly Word[]): Word[][] => {
    const windows: Word[][] = [];
    let current: Word[] = [];
    let pieces = 0;
    for (const word of words) {
        if (pieces + word.pieces.length > WINDOW_PIECES && current.length > 0) {
            windows.push(current);
            current = [];
            pieces = 0;
        }
        current.push(word);
        pieces += word.pieces.length;
    }
    if (current.length > 0) {
        windows.push(current);
    }
    return windows;
};

// Loads the model once; undefined when the pack is not installed or the model will not load, which leaves the
// dictionary to find names alone.
export const loadRecognizer = async (
    dir: string = nerModelDir(),
    warn: (message: string, error: unknown) => void = () => undefined,
): Promise<EntityRecognizer | undefined> => {
    if (!nerInstalled(dir)) {
        return undefined;
    }
    try {
        const transformers = await import("@huggingface/transformers");
        transformers.env.localModelPath = dir;
        transformers.env.cacheDir = dir;
        transformers.env.allowRemoteModels = false;
        // SAFETY: the library's own types describe these as the classes they are; only the members used here are named.
        const tokenizer = (await transformers.AutoTokenizer.from_pretrained(NER_MODEL_ID)) as unknown as Tokenizer;
        const loaded = await transformers.AutoModelForTokenClassification.from_pretrained(NER_MODEL_ID, {
            dtype: "q8",
            session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 },
        });
        // SAFETY: a token-classification model is called with its named input tensors and answers with logits.
        const model = loaded as unknown as Model;
        const config = (loaded as unknown as { config: { id2label?: Record<string, string> } }).config;
        const labels = config.id2label ?? {};
        const Tensor = transformers.Tensor as unknown as TensorConstructor;
        const cls = tokenizer.cls_token_id ?? 0;
        const sep = tokenizer.sep_token_id ?? 2;
        const pieceCache = new Map<string, number[]>();
        const piecesOf = (word: string): number[] => {
            const cached = pieceCache.get(word);
            if (cached !== undefined) {
                return cached;
            }
            const pieces = tokenizer.encode(word, { add_special_tokens: false });
            if (pieceCache.size < 200_000) {
                pieceCache.set(word, pieces);
            }
            return pieces;
        };
        const tensor = (values: readonly number[]): unknown => new Tensor("int64", BigInt64Array.from(values.map(BigInt)), [1, values.length]);

        const labelWindow = async (text: string, window: readonly Word[]): Promise<PersonalDataSpan[]> => {
            const ids = [cls];
            const firstPiece: number[] = [];
            for (const word of window) {
                firstPiece.push(ids.length);
                ids.push(...(word.pieces.length > 0 ? word.pieces : [sep]));
            }
            ids.push(sep);
            const { logits } = await model({
                input_ids: tensor(ids),
                attention_mask: tensor(ids.map(() => 1)),
                token_type_ids: tensor(ids.map(() => 0)),
            });
            const width = logits.dims.at(-1) ?? 1;
            const spans: PersonalDataSpan[] = [];
            let open: { start: number; end: number; tag: string; scores: number[] } | undefined;
            const close = (): void => {
                if (open === undefined) {
                    return;
                }
                const score = open.scores.reduce((sum, value) => sum + value, 0) / open.scores.length;
                const value = text.slice(open.start, open.end);
                // A location is personal only as somebody's address: one with a house number in it.
                const kind = open.tag === "PER" ? "person-name" : open.tag === "LOC" && /\d/u.test(value) ? "address" : undefined;
                if (kind !== undefined && score >= MIN_SCORE && CAPITALIZED.test(value)) {
                    spans.push({ start: open.start, end: open.end, class: kind, value });
                }
                open = undefined;
            };
            window.forEach((word, index) => {
                const at = firstPiece[index] ?? 0;
                const { index: best, score } = softmaxMax(logits.data.subarray(at * width, (at + 1) * width));
                const label = labels[String(best)] ?? "O";
                const [prefix, tag] = label.includes("-") ? [label.slice(0, 1), label.slice(2)] : ["O", ""];
                if (prefix === "O" || tag === "") {
                    close();
                    return;
                }
                if (open !== undefined && open.tag === tag && prefix === "I") {
                    open.end = word.end;
                    open.scores.push(score);
                    return;
                }
                close();
                open = { start: word.start, end: word.end, tag, scores: [score] };
            });
            close();
            return spans;
        };

        // One inference at a time: a request's walker asks for every string at once, and a model run per string in
        // parallel would take every core from the turns it is shielding.
        let queue: Promise<unknown> = Promise.resolve();
        const serially = <T>(work: () => Promise<T>): Promise<T> => {
            const run = queue.then(work, work);
            // allow(silent-catch): the caller awaits `run` itself and sees its failure; the queue only needs to move on.
            queue = run.catch(() => undefined);
            return run;
        };
        return {
            find: async (text) => {
                // Nothing capitalized, no name: most tool output (logs, code, numbers) is turned away before tokenizing.
                if (!CAPITALIZED.test(text)) {
                    return [];
                }
                const words: Word[] = [];
                for (const match of text.matchAll(WORD)) {
                    words.push({ start: match.index, end: match.index + match[0].length, pieces: piecesOf(match[0]) });
                }
                const spans: PersonalDataSpan[] = [];
                for (const window of windowsOf(words)) {
                    if (window.some((word) => CAPITALIZED.test(text.slice(word.start, word.end)))) {
                        spans.push(...(await serially(() => labelWindow(text, window))));
                    }
                }
                return spans;
            },
        };
    } catch (error) {
        warn("privacy shield: the local name model could not be loaded; names are found by the dictionary alone", error);
        return undefined;
    }
};
