import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { errnoCode } from "@intentic/base/errors";
import { parseJsonOr, type JsonValue } from "@intentic/base/json";

// The bundle's interface translations, each served with English filled in under it. The editors take their strings
// from `locale/<lang>.json` alone, with no English left in their code, and fall back to `en.json` only when the whole
// file is missing. A file that lacks some keys leaves those strings undefined, and the pinned build's pl.json lacks
// about a third of every editor's (1096 of the presentation editor's 3567): blank labels at best, and a presentation
// that never opens, since its animation pane lays out the missing "Animation Pane" as text and throws (2026-11-06).

// A translation in the bundle: `web-apps/apps/<editor>/<variant>/locale/<lang>.json`.
const LOCALE = /^(web-apps\/apps\/[^/]+\/[^/]+\/locale)\/([^/]+)\.json$/;
const ENGLISH = "en";

// One locale file: each key's string.
export type Translations = ReadonlyMap<string, string>;

export interface FilledLocale {
    readonly body: Buffer;
    readonly gzipped: Buffer;
}

const isText = (value: JsonValue): value is string => typeof value === "string" && value !== "";

// A locale file's strings, or undefined for a file that is not an object of them; a key whose value is not a string is
// left out, as one the file does not translate.
export const translationsOf = (value: JsonValue): Translations | undefined => {
    if (value === null || Array.isArray(value) || !(value instanceof Object)) {
        return undefined;
    }
    const strings = new Map<string, string>();
    for (const [key, text] of Object.entries(value)) {
        if (isText(text)) {
            strings.set(key, text);
        }
    }
    return strings;
};

// A translation with every key it lacks taken from English.
export const fillLocale = (english: Translations, translated: Translations): Translations => new Map([...english, ...translated]);

const readTranslations = async (file: string): Promise<Translations | undefined> => {
    try {
        const parsed = parseJsonOr(await readFile(file, "utf8"), undefined);
        return parsed === undefined ? undefined : translationsOf(parsed);
    } catch (error) {
        if (errnoCode(error) === "ENOENT") {
            return undefined;
        }
        throw error;
    }
};

// Filled translations by absolute path: a pin's tree never changes, so each is made once per process.
const made = new Map<string, Promise<FilledLocale | undefined>>();

const fill = async (dir: string, folder: string, lang: string): Promise<FilledLocale | undefined> => {
    const [english, translated] = await Promise.all([readTranslations(join(dir, folder, `${ENGLISH}.json`)), readTranslations(join(dir, folder, `${lang}.json`))]);
    if (english === undefined || translated === undefined) {
        return undefined;
    }
    const body = Buffer.from(JSON.stringify(Object.fromEntries(fillLocale(english, translated))));
    return { body, gzipped: gzipSync(body, { level: 6 }) };
};

// The translation at `relative` under the tree at `dir`, filled from English, or undefined to serve the file as it is:
// any other file, English itself, and a translation with no English beside it.
export const filledLocale = (dir: string, relative: string): Promise<FilledLocale | undefined> => {
    const matched = LOCALE.exec(relative);
    if (matched === null || matched[2] === ENGLISH) {
        return Promise.resolve(undefined);
    }
    const key = join(dir, relative);
    let filling = made.get(key);
    if (filling === undefined) {
        filling = fill(dir, matched[1] ?? "", matched[2] ?? "");
        made.set(key, filling);
        // A read that failed is tried again by the next request rather than remembered.
        filling.catch(() => made.delete(key));
    }
    return filling;
};
