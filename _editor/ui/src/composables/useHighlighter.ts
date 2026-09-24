import { createHighlighterCore, type GrammarState, hastToHtml, type HighlighterCore, type ThemedToken } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { langLoader } from "@intentic/code-read/langs";

// Shared Shiki highlighter: one lazily-built core for the app, using the JS RegExp engine (no WASM) with
// dynamically-imported grammars/themes so only rendered languages ship. Emits dual-theme HTML so a theme
// toggle needs no re-highlighting (see code.css).

const THEME_LIGHT = `light-plus`;
const THEME_DARK = `dark-plus`;

// One line's colour tokens, for a surface that interleaves its own markup with the code (the workspace
// search list's match `<mark>`); matches the HTML path's dual-theme pair.
export type CodeToken = Pick<ThemedToken, "content" | "offset" | "htmlStyle">;

// Tokenizes once per grammar at load time, off the render path: a cold grammar's regex compile can
// exceed vscode-textmate's per-line budget and silently mis-colour real code. The nonsense text just
// has to exercise a line's usual rule set.
const WARM_UP = `export class A { async b(c = "d") { return [1, /e/g]; } } // f`;

let core: Promise<HighlighterCore> | undefined;
// lang -> the load in flight or settled; keyed rather than a loaded set, since a burst of requests for
// one language would otherwise each re-import before the first resolves. A rejected load is dropped so
// a later render retries.
const grammars = new Map<string, Promise<HighlighterCore>>();

// Builds the shared core once, off the render path; also what @shikijs/monaco tokenizes with, so
// preview and editor agree.
const ensureCore = (): Promise<HighlighterCore> => {
    if (!core) {
        core = createHighlighterCore({
            themes: [import(`@shikijs/themes/light-plus`), import(`@shikijs/themes/dark-plus`)],
            langs: [],
            // Don't throw on a grammar regex the JS engine can't compile; degrade instead.
            engine: createJavaScriptRegexEngine({ forgiving: true }),
        });
    }
    return core;
};

// Ensures the core and `lang`'s grammar are loaded once however many callers ask at once; shared by
// `highlight`, `tokenizeLine` and the Monaco bridge.
const ensureLang = (lang: string): Promise<HighlighterCore | undefined> => {
    const pending = grammars.get(lang);
    if (pending) {
        return pending;
    }
    const load = langLoader(lang);
    if (!load) {
        return Promise.resolve(undefined);
    }
    const loading = (async () => {
        const instance = await ensureCore();
        await instance.loadLanguage((await load()) as Parameters<HighlighterCore[`loadLanguage`]>[0]);
        instance.codeToTokens(WARM_UP, { lang, themes: { light: THEME_LIGHT, dark: THEME_DARK } });
        return instance;
    })();
    grammars.set(lang, loading);
    // A grammar that failed to load must not be remembered as failed; forget it so the next render retries.
    void loading.catch(() => grammars.delete(lang));
    return loading;
};

// Unsupported langs return undefined so the caller can fall back to raw text.
const highlight = async (code: string, lang: string): Promise<string | undefined> =>
    (await ensureLang(lang))?.codeToHtml(code, { lang, themes: { light: THEME_LIGHT, dark: THEME_DARK } });

type Hast = ReturnType<HighlighterCore[`codeToHast`]>;
type HastNode = Hast[`children`][number];
type HastElement = Extract<HastNode, { type: `element` }>;

// Characters tokenized per slice, each slice one task: about 20ms on the slowest grammar measured, a log of long JSON
// lines at ~11ms per KB.
const SLICE_CHARS = 2_048;
// A line longer than this stays plain: one line cannot be split across slices, and a minified one would be a long task
// of its own.
const MAX_LINE_CHARS = 2_000;

// Characters highlightSliced colours by default: all of an ordinary block, and the readable end of a 1 MB log tail at
// about a third of a second of sliced work instead of ten seconds of frozen page.
const COLOUR_BUDGET = 32_768;

export interface SlicedHighlight {
    // Characters to colour, spent in whole lines; the lines past it stay plain text.
    readonly budget?: number;
    // Which end gets the colour: a log tail's newest lines are last, anything else is read from its first line.
    readonly from: `start` | `end`;
    // True once the caller no longer wants this answer; checked between slices, so an outdated input stops early.
    readonly stale: () => boolean;
}

const nextTask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// Shiki's `<pre><code>`, whose children are its line spans.
const codeOf = (hast: Hast): HastElement => ((hast.children[0] as HastElement).children[0] as HastElement);

const plainLine = (text: string): HastElement => ({ type: `element`, tagName: `span`, properties: { class: `line` }, children: [{ type: `text`, value: text }] });

// How many lines, taken from one end, fit the budget; always at least one.
const linesWithin = (lines: readonly string[], budget: number): number => {
    let spent = 0;
    let count = 0;
    for (const line of lines) {
        if (count > 0 && spent + line.length + 1 > budget) {
            break;
        }
        spent += line.length + 1;
        count += 1;
    }
    return count;
};

// highlight() for input of any size: colours at most `budget` characters, tokenized a slice per task with the grammar
// state carried across, so no input holds the main thread for longer than one slice. Same markup as highlight(), the
// uncoloured lines plain inside it; undefined for an unsupported language or a caller gone stale.
const highlightSliced = async (code: string, lang: string, options: SlicedHighlight): Promise<string | undefined> => {
    const instance = await ensureLang(lang);
    if (instance === undefined || options.stale()) {
        return undefined;
    }
    const lines = code.split(`\n`);
    const count = linesWithin(options.from === `start` ? lines : lines.toReversed(), options.budget ?? COLOUR_BUDGET);
    const first = options.from === `start` ? 0 : lines.length - count;
    const coloured = lines.slice(first, first + count);
    let root: Hast | undefined;
    let state: GrammarState | undefined;
    const body: HastNode[] = [];
    for (let at = 0; at < coloured.length; ) {
        let end = at;
        let size = 0;
        while (end < coloured.length && (end === at || size + coloured[end]!.length + 1 <= SLICE_CHARS)) {
            size += coloured[end]!.length + 1;
            end += 1;
        }
        if (at > 0) {
            await nextTask();
            if (options.stale()) {
                return undefined;
            }
        }
        const hast = instance.codeToHast(coloured.slice(at, end).join(`\n`), {
            lang,
            themes: { light: THEME_LIGHT, dark: THEME_DARK },
            tokenizeMaxLineLength: MAX_LINE_CHARS,
            ...(state === undefined ? {} : { grammarState: state }),
        });
        state = instance.getLastGrammarState(hast);
        root ??= hast;
        body.push(...(body.length === 0 ? [] : [{ type: `text` as const, value: `\n` }]), ...codeOf(hast).children);
        at = end;
    }
    if (root === undefined) {
        return undefined;
    }
    const newline = { type: `text` as const, value: `\n` };
    const before = lines.slice(0, first).flatMap((line) => [plainLine(line), newline]);
    const after = lines.slice(first + count).flatMap((line) => [newline, plainLine(line)]);
    codeOf(root).children = [...before, ...(body as HastElement[`children`]), ...after];
    return hastToHtml(root);
};

// Tokenizes a single line with no grammar state carried in from lines above it, all a lifted snippet can offer.
const tokenizeLine = async (line: string, lang: string): Promise<readonly CodeToken[] | undefined> =>
    (await ensureLang(lang))?.codeToTokens(line, { lang, themes: { light: THEME_LIGHT, dark: THEME_DARK } }).tokens[0];

export function useHighlighter() {
    return { highlight, highlightSliced, tokenizeLine, ensureCore, ensureLang };
}
