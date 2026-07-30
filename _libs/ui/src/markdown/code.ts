import { ref } from "vue";

/* Fenced code blocks inside rendered markdown: Shiki colouring plus a copy button.
 *
 * The markup is built here as a raw string and substituted into the ALREADY-SANITIZED HTML by
 * renderMarkdown, rather than being produced inside the markdown pipeline. Two reasons: DOMPurify never has
 * to walk Shiki's few-hundred colour <span>s per block (the settled prefix is re-sanitized every time it
 * grows, so that cost would be paid again and again), and Shiki's inline token styles can't be stripped by
 * it. Nothing untrusted rides along — the code text is escaped here on the fallback path and by Shiki itself
 * on the highlighted one.
 *
 * Highlighting is asynchronous (grammars are dynamically imported) while rendering is synchronous, so a miss
 * returns the plain fallback and schedules the work. `highlightVersion` then invalidates every markdown
 * computed that read it, and the re-render hits the cache. */

export interface CodeBlock {
    readonly code: string;
    readonly lang: string;
}

// Minimal HTML escape — enough to render arbitrary text inertly inside v-html. Shared with renderMarkdown's
// crash fallback, which has the same job.
export const escapeHtml = (text: string): string => text.replace(/&/g, `&amp;`).replace(/</g, `&lt;`).replace(/>/g, `&gt;`).replace(/"/g, `&quot;`);

// Fence infos agents actually write, mapped onto the grammar ids the app ships (see shikiLangs.ts). Anything
// not listed is tried as-is and, if we don't ship it, remembered as unsupported after one attempt.
const ALIASES: Record<string, string> = {
    "c++": `cpp`,
    cjs: `javascript`,
    console: `bash`,
    dockerfile: `docker`,
    env: `dotenv`,
    htm: `html`,
    js: `javascript`,
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

// Past this a chat code block is a dumped file, where colour is worth less than a responsive turn — Shiki's
// cost scales with the token count. Oversized blocks stay plain (and still copyable).
const MAX_HIGHLIGHT_LINES = 500;

/* How many blocks of ONE document get coloured. The same trade as the line cap above, in the other dimension:
 * a document's 3000th fenced block is worth less than a document that renders at all.
 *
 * It is also what keeps a big document inside the cache below. Colour arriving invalidates the render that
 * asked for it, so a render is repeated once per landing highlight — and with more blocks than the cache
 * holds, every repeat evicted entries the next one would miss again, re-scheduling them forever. A 1.9 MiB
 * document with 3353 blocks never stopped re-rendering: each pass cost ~500ms of parse plus ~1.3s of layout
 * for 77k nodes, and the page never reached DOMContentLoaded. Under this cap the work is bounded and the
 * cache holds what one document needs, so the repeats end. */
const MAX_HIGHLIGHT_BLOCKS = 150;

// `lang\ncode` → Shiki HTML, or `` for a language we don't ship (remembered so it's attempted only once).
// Recency-ordered via Map insertion order, so the cap evicts the least recently used. Comfortably above
// MAX_HIGHLIGHT_BLOCKS: one document's blocks must all fit, or rendering it evicts its own colour.
const CACHE_LIMIT = 400;
const cache = new Map<string, string>();
const inFlight = new Set<string>();

// Bumped when highlights land. Read on every render (see codeBlockHtml) so the markdown computed that rendered
// a not-yet-highlighted block re-runs once its colour is ready.
const highlightVersion = ref(0);
// Whether any highlight in the current batch produced markup worth re-rendering for.
let landed = false;

/* One bump per BATCH, not per highlight: a document's blocks are all scheduled by the same render, so waiting
 * for the last of them to settle turns N re-renders of the whole document into one. Per-highlight bumps were
 * the storm — each landing invalidated the render, and every re-render scheduled the next landing, so the cost
 * was quadratic in the block count and ran entirely in microtasks, which starves timers and paint. */
const settleBatch = (): void => {
    if (inFlight.size > 0 || !landed) {
        return;
    }
    landed = false;
    highlightVersion.value += 1;
};

/* The shared Shiki instance is reached through a dynamic import rather than a top-level one: it drags in
 * shiki/core plus both themes, and a surface that renders prose without a single fenced block should not pay
 * for them. Highlighting is already async, so deferring the module costs nothing. The import names the
 * composable module directly, never the design-system barrel — the barrel pulls in .vue components, and this
 * engine is also exercised from plain node unit tests. */
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

// This block's Shiki HTML if it is already in the cache, otherwise undefined — scheduling the highlight so a
// later render can have it.
const highlighted = (block: CodeBlock, index: number): string | undefined => {
    // Read unconditionally: a block that misses today must re-render when its colour lands, and a computed
    // only re-runs on a dependency it actually read.
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
                    // A language we don't ship changes nothing on screen — don't invalidate for it.
                    landed ||= html !== undefined;
                    settleBatch();
                },
                () => {
                    // Grammar chunk failed to load (offline, or a test env that can't resolve it). Leave it
                    // uncached so a later render retries.
                    inFlight.delete(key);
                    settleBatch();
                },
            );
    }
    return undefined;
};

/* One code block's markup. `colour` is false for the still-being-written tail of a streaming turn: its text
 * changes every frame, so highlighting it would thrash the cache for a block that is about to settle and be
 * highlighted exactly once.
 *
 * `index` is the block's position in its document, which is what MAX_HIGHLIGHT_BLOCKS bounds — colour goes to
 * the blocks a reader reaches, not to the three-thousandth one in a generated report.
 *
 * The wrapper reuses `ui-code`, the class the design system's <Code> component uses, so the Shiki chrome and
 * its dark-mode token flip (code.css) govern chat code blocks and the file viewer identically. */
export const codeBlockHtml = (block: CodeBlock, index: number, colour: boolean): string => {
    const shiki = colour ? highlighted(block, index) : undefined;
    // The uncoloured fallback carries Shiki's own class so code.css gives it identical chrome — the block
    // gains colour when highlighting lands without shifting size or position.
    const body = shiki ?? `<pre class="shiki"><code>${escapeHtml(block.code)}</code></pre>`;
    return (
        `<div class="ui-code md-code">` +
        `<div class="md-code-bar">` +
        `<span class="md-code-lang">${escapeHtml(block.lang.trim())}</span>` +
        `<button type="button" class="md-code-copy" aria-label="Copy code">Copy</button>` +
        `</div>${body}</div>`
    );
};

/* Copy handler for the buttons above. Delegated — the markup lives inside v-html, so it can hold no
 * component and no per-block listener; one handler on the prose root covers every block in it. The text
 * comes from the rendered <code> rather than a data attribute, so it costs no duplicate copy of the code and
 * reads the same whether the block is highlighted or plain. */
export const copyCodeFromEvent = (event: MouseEvent): void => {
    const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>(`.md-code-copy`);
    const code = button?.closest(`.md-code`)?.querySelector(`code`)?.textContent;
    if (!button || code === null || code === undefined) {
        return;
    }
    void navigator.clipboard.writeText(code).then(
        () => {
            button.textContent = `Copied`;
            setTimeout(() => (button.textContent = `Copy`), 1500);
        },
        () => undefined, // Clipboard unavailable (insecure context); the text is still selectable.
    );
};
