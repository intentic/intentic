import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { langLoader } from "./langs.js";
import { analyzeCode, type CodeAnalysis } from "./analysis.js";
import type { Grammars } from "./tokens.js";

// A tokenizer for a process with no screen: the daemon needs to know which lines of a changed file are comment, for the
// diff a review shows. Unused by the app, which already has grammars loaded for its own renderer. Uses the JS RegExp
// engine (forgiving, no WASM asset), loading a grammar lazily, once per process.

let core: Promise<HighlighterCore> | undefined;
// Load in flight or settled, per language, so many files share one grammar load; a rejection retries.
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
