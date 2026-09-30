import { ref } from "vue";
import { clipboardOf } from "../lib/clipboard.js";
import { loadChunk } from "../lib/loadChunk.js";
import { createWorkerCall } from "../lib/workerCall.js";
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

const HTML_ENTITIES: Record<string, string> = { "&": `&amp;`, "<": `&lt;`, ">": `&gt;`, '"': `&quot;`, "'": `&#39;` };

// Minimal HTML escape for rendering arbitrary text inertly inside v-html; shared with renderMarkdown's fallback. Local
// rather than @intentic/base's copy: this package carries no workspace dependency but @intentic/code-read.
export const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (ch) => HTML_ENTITIES[ch] ?? ch);

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

// Bumped when highlights land, so a render that missed the cache re-runs once colour is ready. Exported for the
// editing surface, which builds its DOM imperatively and so has no computed to invalidate.
export const highlightVersion = ref(0);
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
// unit tests. Sliced (highlightSliced): a block is coloured 2 KB per task with the grammar state carried across, so a
// long block never holds the main thread for longer than one slice.
type Highlight = (code: string, lang: string) => Promise<string | undefined>;
let highlighter: Promise<Highlight> | undefined;

// OFF THE MAIN THREAD, where the page asks for it (the app does, from main.ts): the highlight runs in a worker
// (highlightWorker.ts, through the kit's one worker protocol) and answers with the same HTML. Opt-in rather than
// automatic because this engine also runs where there is no page to protect (node unit tests); a worker that cannot
// start, or dies, hands its calls to the page's own thread, which is what every highlight did before.
let workerWanted = false;
export const highlightInWorker = (): void => {
    workerWanted = true;
};

const inWorker = createWorkerCall<{ readonly code: string; readonly lang: string }, string | undefined>(
    async () => (`Worker` in globalThis ? new Worker(new URL(`./highlightWorker.ts`, import.meta.url), { type: `module` }) : undefined),
    async ({ code, lang }) => (await loadInPage())(code, lang),
);

// A failed load is forgotten, so the next fence asks again instead of rendering plain for the life of the tab.
const loadHighlighter = (): Promise<Highlight> =>
    (highlighter ??= workerWanted ? Promise.resolve((code: string, lang: string) => inWorker({ code, lang })) : loadInPage());

const loadInPage = (): Promise<Highlight> =>
    loadChunk(() => import(`../composables/useHighlighter.js`)).then(
        (module) => {
            const { highlightSliced } = module.useHighlighter();
            return (code: string, lang: string) => highlightSliced(code, lang, { from: `start`, stale: () => false });
        },
        (error: unknown) => {
            highlighter = undefined;
            throw error;
        },
    );

// ONE BLOCK AT A TIME, EACH IN A TASK OF ITS OWN. Every block a render scheduled used to chain onto the highlighter's
// load, so all of them ran in the one microtask drain its load resolved in: opening a chat with forty code blocks was a
// single task of about a second at 4× CPU throttle, which a phone spends with the chat frozen under the reader's finger.
// Queued, the page gets a turn between blocks — a tap, a scroll, a frame.
const waiting: (() => Promise<void>)[] = [];
let draining = false;
const nextTask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const drain = async (): Promise<void> => {
    if (draining) {
        return;
    }
    draining = true;
    try {
        for (let job = waiting.shift(); job !== undefined; job = waiting.shift()) {
            await job();
            await nextTask();
        }
    } finally {
        draining = false;
    }
};
const enqueue = (job: () => Promise<void>): void => {
    waiting.push(job);
    void drain();
};

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

/**
 * This code's Shiki HTML if already cached, otherwise undefined while the highlight is scheduled. `info` is a
 * fence's info string, not a grammar id. Shared with the editing surface, which colours the same blocks.
 */
export const highlightedCode = (code: string, info: string): string | undefined => {
    // Read unconditionally, since a computed only re-runs on a dependency it actually read.
    void highlightVersion.value;
    const lang = langId(info);
    if (lang === undefined || code.split(`\n`).length > MAX_HIGHLIGHT_LINES) {
        return undefined;
    }
    const key = `${lang}\n${code}`;
    const hit = cache.get(key);
    if (hit !== undefined) {
        cache.delete(key);
        cache.set(key, hit);
        return hit === `` ? undefined : hit;
    }
    if (!inFlight.has(key)) {
        inFlight.add(key);
        enqueue(() =>
            loadHighlighter()
            .then((highlight) => highlight(code, lang))
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
            ),
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
    const shiki = colour && index < MAX_HIGHLIGHT_BLOCKS ? highlightedCode(block.code, block.lang) : undefined;
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
