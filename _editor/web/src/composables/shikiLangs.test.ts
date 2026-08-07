// @vitest-environment jsdom
import { useHighlighter } from "@intentic/ui";
import { LANGS } from "@intentic/ui/langs";
import { expect, test, vi } from "vitest";
import { codeLangForPath } from "../pages/workspace/fileType";

/* The grammar table's two silent-failure modes, neither of which the compiler can see.
 *
 * `ShikiLang` now types every surface that NAMES a grammar, so a name we ship nothing for does not compile —
 * that was the sandbox Environment card rendering its approved overlay as grey plain text under `dockerfile`
 * (the id is `docker`), directly below a diff of the same file that was coloured. What a union type cannot
 * check is whether an id's dynamic import still RESOLVES: a renamed or dropped @shikijs/langs entry type-checks
 * perfectly and degrades to exactly the same plain text. Hence the load-everything test below.
 *
 * The @intentic/ui barrel that carries useHighlighter reaches window.matchMedia (useDevice) at import —
 * hence jsdom plus the stub jsdom itself doesn't ship. Nothing under test touches the DOM. */
vi.hoisted(() => {
    globalThis.matchMedia ??= ((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
        addListener: () => {},
        removeListener: () => {},
    })) as typeof globalThis.matchMedia;
});

// Every grammar we ship, imported and compiled from cold in one test — `ensureLang` tokenizes a warm-up line
// per language precisely so the rules compile off the render path, and that work all lands here. Seconds of
// real work against a suite budget sized for the milliseconds every other test spends, so it gets its own,
// big enough that only a hang reaches it on a runner shared with every other suite.
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
    // An instruction keyword is split into its OWN span, which is the whole difference from the plain <pre>
    // fallback: uncoloured, `FROM intentic/sandbox:latest` is a single undivided text run.
    const colourOf = (token: string): string | undefined => new RegExp(`color:(#[0-9A-F]{6})[^"]*">${token}<`).exec(html)?.[1];
    expect(colourOf(`FROM`)).toBeDefined();
    expect(colourOf(`ENV`)).toBe(colourOf(`FROM`));
    // And a comment is a different colour again — one shade for everything would still be "no highlighting".
    expect(html).toMatch(/color:(#[0-9A-F]{6})[^"]*"># the Environment card/);
    expect(colourOf(`FROM`)).not.toBe(/color:(#[0-9A-F]{6})[^"]*"># the/.exec(html)?.[1]);
});

test(`the overlay's Code block and the diff above it resolve to the same grammar`, () => {
    // The card shows a proposal as a DiffView keyed by path and the approved result as <Code lang="docker">.
    // They disagreed before, which is what made the missing colour visible rather than merely absent.
    expect(codeLangForPath(`environment.custom.Dockerfile`)).toBe(`docker`);
    expect(Object.keys(LANGS)).toContain(codeLangForPath(`environment.custom.Dockerfile`));
});
