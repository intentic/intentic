import { ref } from "vue";
import { clipboardOf } from "../lib/clipboard.js";
import type { ShikiLang } from "@intentic/code-read/langs";
import { JSON_FIGURE_LANGS } from "./figures.js";

// Fenced code blocks: Shiki coloring plus a copy button, built as a raw string substituted into the
// already-sanitized HTML rather than the markdown pipeline, so DOMPurify isn't re-walking Shiki's spans on every
// re-sanitize. Highlighting is async while rendering is sync: a miss returns the plain fallback and schedules the
// work; `highlightVersion` invalidates renders once it lands.

export interface CodeBlock {
    readonly code: string;
    readonly lang: string;
}

// Minimal HTML escape for rendering arbitrary text inertly inside v-html; shared with renderMarkdown's fallback.
export const escapeHtml = (text: string): string => text.replace(/&/g, `&amp;`).replace(/</g, `&lt;`).replace(/>/g, `&gt;`).replace(/"/g, `&quot;`);

// Fence info strings mapped to shipped grammar ids; unlisted ones are tried as-is and remembered as unsupported
// after one miss. JSON-figure langs (figures.ts) alias to `json`, since a figure that fails to render still shows
// its body as JSON, not a diagram.
const ALIASES: Record<string, ShikiLang> = {
    ...Object.fromEntries(JSON_FIGURE_LANGS.map((lang) => [lang, `json`])),
    "c++": `cpp`,
    cjs: `javascript`,
    console: `bash`,
    dockerfile: `docker`,
    env: `dotenv`,
    htm: `html`,
    js: `javascript`,
    // Coloured as JSON, matching how fileType.ts reads .jsonc/.json5 files.
    json5: `json`,
    jsonc: `json`,
    kt: `kotlin`,
    makefile: `make`,
    md: `markdown`,
    mjs: `javascript`,
    patch: `diff`,
    ps1: `powershell`,
    py: `python`,
    rb: `ruby`,
    rs: `rust`,
    sh: `bash`,
    shell: `bash`,
    ts: `typescript`,
    yml: `yaml`,
    zsh: `bash`,
};

// Past this a block is a dumped file: colour costs more than it's worth. Stays plain, still copyable.
const MAX_HIGHLIGHT_LINES = 500;

// Caps how many blocks of one document get coloured, and keeps a document's colours inside the cache below.
// Raising it past what the cache holds re-triggers eviction and re-scheduling in a loop that never settles.
const MAX_HIGHLIGHT_BLOCKS = 150;

// `lang\ncode` to Shiki HTML, or `` for an unshipped language (tried once). LRU via Map insertion order; kept
// comfortably above MAX_HIGHLIGHT_BLOCKS so one document's own blocks can't evict each other.
const CACHE_LIMIT = 400;
const cache = new Map<string, string>();
const inFlight = new Set<string>();

// Bumped when highlights land, so a render that missed the cache re-runs once colour is ready.
const highlightVersion = ref(0);
// Whether any highlight in the current batch produced markup worth re-rendering for.
let landed = false;

// One version bump per batch, not per highlight: a document's blocks are all scheduled by the same render, so
// this waits for the last to settle instead of re-rendering once per landing.
const settleBatch = (): void => {
    if (inFlight.size > 0 || !landed) {
        return;
    }
    landed = false;
    highlightVersion.value += 1;
};

// Dynamic import, not top-level: shiki/core plus both themes shouldn't load for prose with no fenced block.
// Imports useHighlighter.js directly, not the design-system barrel, since this engine also runs from plain node
// unit tests.
let highlighter: Promise<(code: string, lang: string) => Promise<string | undefined>> | undefined;
const loadHighlighter = (): Promise<(code: string, lang: string) => Promise<string | undefined>> =>
    (highlighter ??= import(`../composables/useHighlighter.js`).then((module) => module.useHighlighter().highlight));

// The fence's info string reduced to a grammar id: `ts`, but also ```` ```ts title=x ```` and ```` ```TS ````.
const langId = (fence: string): string | undefined => {
    const word = fence
        .trim()
        .toLowerCase()
        .split(/[\s:,{]/)[0];
    if (word === undefined || word === ``) {
        return undefined;
    }
    return ALIASES[word] ?? word;
};

// This block's Shiki HTML if already cached, otherwise undefined while scheduling the highlight.
const highlighted = (block: CodeBlock, index: number): string | undefined => {
    // Read unconditionally, since a computed only re-runs on a dependency it actually read.
    void highlightVersion.value;
    const lang = langId(block.lang);
    if (lang === undefined || index >= MAX_HIGHLIGHT_BLOCKS || block.code.split(`\n`).length > MAX_HIGHLIGHT_LINES) {
        return undefined;
    }
    const key = `${lang}\n${block.code}`;
    const hit = cache.get(key);
    if (hit !== undefined) {
        cache.delete(key);
        cache.set(key, hit);
        return hit === `` ? undefined : hit;
    }
    if (!inFlight.has(key)) {
        inFlight.add(key);
        void loadHighlighter()
            .then((highlight) => highlight(block.code, lang))
            .then(
                (html) => {
                    inFlight.delete(key);
                    cache.set(key, html ?? ``);
                    if (cache.size > CACHE_LIMIT) {
                        const oldest = cache.keys().next().value;
                        if (oldest !== undefined) {
                            cache.delete(oldest);
                        }
                    }
                    // A language we don't ship changes nothing on screen, don't invalidate for it.
                    landed ||= html !== undefined;
                    settleBatch();
                },
                () => {
                    // Grammar chunk failed to load; left uncached so a later render retries.
                    inFlight.delete(key);
                    settleBatch();
                },
            );
    }
    return undefined;
};

// Which block shows "Copied", held as the copied text rather than written onto the button: a streaming
// re-render replaces the block's DOM wholesale and would erase a DOM-poked flash. A ref, so setting it
// invalidates the markdown computeds that display it.
const COPIED_MS = 1500;
const copiedVersion = ref(0);
let copiedCode: string | undefined;
let copiedTimer: ReturnType<typeof setTimeout> | undefined;

const markCopied = (code: string | undefined): void => {
    copiedCode = code;
    copiedVersion.value += 1;
    clearTimeout(copiedTimer);
    copiedTimer = code === undefined ? undefined : setTimeout(() => markCopied(undefined), COPIED_MS);
};

// One code block's markup. `colour=false` skips highlighting a streaming tail (still changing every frame) to
// avoid cache thrash; `index` bounds against MAX_HIGHLIGHT_BLOCKS.
export const codeBlockHtml = (block: CodeBlock, index: number, colour: boolean): string => {
    const shiki = colour ? highlighted(block, index) : undefined;
    // Fallback carries Shiki's own class, so colour landing later doesn't shift size or position.
    const body = shiki ?? `<pre class="shiki"><code>${escapeHtml(block.code)}</code></pre>`;
    const lang = escapeHtml(block.lang.trim());
    // Read unconditionally, so the block that isn't copied today re-renders once it is.
    void copiedVersion.value;
    const copied = block.code === copiedCode;
    return (
        `<div class="ui-code md-code">` +
        `<div class="md-code-actions">${
            lang === `` ? `` : `<span class="md-code-lang">${lang}</span>`
        }<button type="button" class="md-code-copy${copied ? ` md-code-copied` : ``}" aria-label="Copy ${lang === `` ? `` : `${lang} `}code">${
            copied ? `Copied` : `Copy`
        }</button>` +
        `</div>${body}</div>`
    );
};

// Delegated copy handler for v-html markup (no per-block listeners); reads the code from the rendered <code>, not
// a data attribute. Bound to both `pointerdown` and `click`: a streaming turn replaces the block's DOM every
// frame, so `click` alone can miss because the pressed button is already gone by mouseup.
export const copyCodeFromEvent = (event: Event): void => {
    // Not `instanceof MouseEvent`: another window's events use different constructors. Absent on a keyboard click.
    if (`button` in event && event.button !== 0) {
        return;
    }
    const button = (event.target as HTMLElement | null)?.closest(`.md-code-copy`);
    const code = button?.closest(`.md-code`)?.querySelector(`code`)?.textContent;
    if (code === null || code === undefined || code === copiedCode) {
        return;
    }
    void clipboardOf(button)
        .writeText(code)
        .then(
            () => markCopied(code),
            () => undefined, // Clipboard unavailable (insecure context); the text is still selectable.
        );
};
