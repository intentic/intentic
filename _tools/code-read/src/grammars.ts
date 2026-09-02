import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { langLoader } from "./langs.js";
import { analyzeCode, type CodeAnalysis } from "./analysis.js";
import type { Grammars } from "./tokens.js";

/* A TOKENIZER FOR A PROCESS WITH NO SCREEN, which is what the daemon is: it never colours a line, but it has to
 * be able to say which lines of a changed file are comment, because the +/− a review shows is the code's and the
 * daemon is what ships those numbers with the change list.
 *
 * The app does NOT use this. In the browser the grammars are already loaded to paint the file, and a second core
 * beside them would hold a second copy of every grammar a review touches; the reading there rides the renderer's
 * own core (useHighlighter) and this module is the answer to the same question on the other side of the wire.
 *
 * The JavaScript RegExp engine rather than the WASM one, exactly as the app builds it: no binary asset to resolve
 * from a bundle, a dist directory or a container image, and `forgiving` so a grammar rule this engine cannot
 * compile degrades to fewer tokens rather than throwing inside a change list. Grammars load lazily, per language,
 * once per process: a daemon that only ever sees TypeScript never pays for the other thirty-eight. */

let core: Promise<HighlighterCore> | undefined;
// lang → the load in flight or already settled, so a changeset of two hundred TypeScript files registers the
// grammar once rather than two hundred times. A rejected load is dropped so a later file retries.
const loaded = new Map<string, Promise<HighlighterCore | undefined>>();

const ensureCore = (): Promise<HighlighterCore> => {
    core ??= createHighlighterCore({ themes: [], langs: [], engine: createJavaScriptRegexEngine({ forgiving: true }) });
    return core;
};

const ensureLang = (lang: string): Promise<HighlighterCore | undefined> => {
    const pending = loaded.get(lang);
    if (pending !== undefined) {
        return pending;
    }
    const load = langLoader(lang);
    if (load === undefined) {
        return Promise.resolve(undefined);
    }
    const loading = (async () => {
        const instance = await ensureCore();
        await instance.loadLanguage((await load()) as Parameters<HighlighterCore[`loadLanguage`]>[0]);
        return instance;
    })();
    loaded.set(lang, loading);
    void loading.catch(() => loaded.delete(lang));
    return loading;
};

/** This process's grammars, for `walkTokens`. */
export const grammars: Grammars = async (lang) => (await ensureLang(lang))?.getLanguage(lang);

/** `analyzeCode` bound to them: the whole reading, in one call, for a caller that has no core of its own. */
export const analyze = (text: string, lang: string | undefined): Promise<CodeAnalysis | undefined> => analyzeCode(text, lang, grammars);
