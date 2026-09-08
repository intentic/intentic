// @vitest-environment jsdom
import { useHighlighter } from "@intentic/ui";
import { LANGS } from "@intentic/code-read/langs";
import { expect, test } from "vitest";
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
    expect(Object.keys(LANGS)).toContain(codeLangForPath(`environment.custom.Dockerfile`));
});
