import "@intentic/testing/dom";
import { useHighlighter } from "@intentic/ui";
import { LANGS } from "@intentic/code-read/langs";
import { codeLangForPath } from "@intentic/code-read";

// The grammar table's two silent-failure modes, neither visible to the compiler. `ShikiLang` types every surface that
// names a grammar, so an id we ship nothing for does not compile, but a union type cannot check whether an id's dynamic
// import still resolves: a renamed or dropped @shikijs/langs entry type-checks and degrades to plain text just the
// same. Hence the load-everything test below.
//
// The @intentic/ui barrel that carries useHighlighter reaches window.matchMedia (useDevice) at import: hence jsdom,
// though nothing under test touches the DOM.

// Every grammar shipped, imported and compiled from cold in one test: `ensureLang` tokenizes a warm-up line per
// language, which is real work against a suite otherwise sized for milliseconds, so it gets its own generous budget.
test(`every id in LANGS loads the grammar it names`, async () => {
    const { ensureLang } = useHighlighter();
    const missing = (await Promise.all(Object.keys(LANGS).map(async (id) => [id, await ensureLang(id)] as const)))
        .filter(([, core]) => core === undefined)
        .map(([id]) => id);
    expect(missing).toEqual([]);
}, 60_000);

test(`the overlay's instructions and comments come out as distinct colours`, async () => {
    const overlay = `FROM intentic/sandbox:latest\n# the Environment card's approved overlay\nENV PATH=/root/.cargo/bin:$PATH\n`;
    const html = (await useHighlighter().highlight(overlay, `docker`)) ?? ``;
    // An instruction keyword is split into its own span, the whole difference from the plain <pre> fallback:
    // uncoloured, the line is a single undivided text run.
    const colourOf = (token: string): string | undefined => new RegExp(`color:(#[0-9A-F]{6})[^"]*">${token}<`).exec(html)?.[1];
    expect(colourOf(`FROM`)).toEqual(expect.any(String));
    expect(colourOf(`ENV`)).toBe(colourOf(`FROM`));
    // And a comment is a different colour again: one shade for everything would still be "no highlighting".
    expect(html).toMatch(/color:(#[0-9A-F]{6})[^"]*"># the Environment card/);
    expect(colourOf(`FROM`)).not.toBe(/color:(#[0-9A-F]{6})[^"]*"># the/.exec(html)?.[1]);
});

test(`the overlay's Code block and the diff above it resolve to the same grammar`, () => {
    // The card shows a proposal as a DiffView keyed by path and the approved result as <Code lang="docker">; they must
    // resolve to the same grammar.
    expect(codeLangForPath(`environment.custom.Dockerfile`)).toBe(`docker`);
    expect<(string | undefined)[]>(Object.keys(LANGS)).toContain(codeLangForPath(`environment.custom.Dockerfile`));
});

// highlightSliced tokenizes a slice per task. Within its budget it must colour exactly as highlight() does, which only
// holds if grammar state carries across every slice boundary.

const { highlight, highlightSliced } = useHighlighter();
const fresh = { stale: () => false };

// A few KB of TypeScript whose block comments and template strings run across lines, so slice cuts land inside them.
const source = Array.from(
    { length: 60 },
    (_, index) => `/* note ${index}\n   still the comment ${index}\n*/\nexport const value${index} = \`line one\n${"x".repeat(40)} ${index}\`;`,
).join(`\n`);

describe(`highlightSliced`, () => {
    it(`colours input within its budget exactly as one whole pass does, across slice boundaries`, async () => {
        expect(source.length).toBeGreaterThan(2 * 2_048);
        expect(await highlightSliced(source, `typescript`, { ...fresh, from: `start` })).toBe(await highlight(source, `typescript`));
    });

    it(`colours only the budgeted end and keeps every other line as plain text`, async () => {
        const lines = Array.from({ length: 50 }, (_, index) => `const n${index} = ${index};`);
        const code = lines.join(`\n`);
        const budget = lines.slice(-5).join(`\n`).length + 1;
        const html = (await highlightSliced(code, `typescript`, { ...fresh, from: `end`, budget }))!;
        expect(html.match(/<span class="line">/g)).toHaveLength(50);
        expect(html).toContain(`<span class="line">const n44 = 44;</span>`);
        expect(html).not.toContain(`<span class="line">const n45 = 45;</span>`);
        expect(html.match(/style=/g)?.length).toBeGreaterThan(5);
    });

    it(`stops once the caller has moved on, and answers nothing for a language it does not ship`, async () => {
        expect(await highlightSliced(source, `typescript`, { from: `start`, stale: () => true })).toBeUndefined();
        expect(await highlightSliced(`x`, `no-such-language`, { ...fresh, from: `start` })).toBeUndefined();
    });
});
