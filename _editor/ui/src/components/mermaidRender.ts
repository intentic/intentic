import { mermaidTheme } from "./mermaidTheme.js";

/* THE ONE MERMAID — the whole of what is global about drawing a diagram, kept in one module because every part
 * of it is a singleton and a component instance is not.
 *
 * Mermaid is a library with one configuration, one measuring area under <body> and one diagram registry. A
 * document is not one diagram: the page that prompted this feature holds four. So three things have to be
 * owned above the component:
 *
 * THE ID. Mermaid scopes the <style> it emits to the id it was handed and looks its own scaffolding up by that
 * id while laying out. A counter inside the component is per INSTANCE, so every diagram on the page asked for
 * `md-mermaid-1` — and the renders then read each other's elements: two of four came back as an svg with a
 * stylesheet and no nodes in it, drawn as a blank gap in the middle of the prose. The counter belongs here,
 * where there is exactly one of it.
 *
 * THE ORDER. `initialize` writes the shared config and `render` reads it, so the pair has to be atomic — a
 * theme flip landing between them draws the new diagram in the old palette. Mermaid queues renders internally;
 * this queue is what puts the configuration inside the same slot as the render it configures.
 *
 * THE IMPORT. Mermaid is a megabyte of diagram grammars, loaded on the first document that holds a diagram and
 * never on the many that do not. */

let ids = 0;
let queue: Promise<unknown> = Promise.resolve();

/* THE DEADLINE — the one failure a diagram cannot show on its own.
 *
 * MermaidDiagram has three states: drawn, refused, and not yet. A refusal puts the fenced source on screen, so
 * every way this function can FAIL is already visible to the reader. What it cannot survive is a promise that
 * never settles: the component keeps its "not yet" placeholder, which is a wash the size of a small diagram,
 * and a reader looking at that grey box has no way to tell it from a diagram the app has quietly given up on.
 *
 * Two things in here can hang rather than fail. The import is a megabyte fetched over whatever link the app is
 * running on, and a stalled response never rejects — it simply never arrives. Mermaid's own layout measures
 * text in a scratch DOM, which a pathological diagram can sit in. So a render that misses this budget is
 * treated exactly like a refusal, and the reader gets the source: what this surface showed before it drew
 * diagrams at all, which makes a timeout no worse than not having the feature.
 *
 * It is also what stops ONE diagram from taking the page. The queue below only advances when this promise
 * settles, so without a deadline a single hung render leaves every later diagram waiting behind it — a whole
 * conversation of grey boxes from one bad draw. Generous on purpose: a slow first load should finish, not be
 * cut off a second before it arrives. */
const DRAW_BUDGET_MS = 15_000;

/* A timed-out render may still be running when the next one starts, which is the interleaving the queue exists
 * to prevent (see THE ID and THE ORDER above). Deliberate: that render has already failed the reader, and
 * letting the rest of the page draw is worth more than protecting a result nobody is waiting for any more. */
const bounded = async (work: Promise<string>): Promise<string> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            work,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`mermaid did not draw within ${DRAW_BUDGET_MS}ms`)), DRAW_BUDGET_MS);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
};

/* One diagram's SVG markup, or a rejection when mermaid will not draw it (invalid syntax, a diagram type this
 * build does not know, or the deadline above) — the caller shows the source instead.
 *
 * `securityLevel: strict` is mermaid's own DOMPurify pass over every label plus no `click` bindings, which is
 * the defence markdown/render.ts already applies to the prose around the diagram; documents here are as
 * untrusted as the files they came from. `suppressErrorRendering` is what makes a refusal a rejection: without
 * it mermaid paints its own error card into the page and leaves the scaffolding it measured with behind. */
export const renderMermaid = (code: string, scheme: "light" | "dark", font: string): Promise<string> => {
    const work = async (): Promise<string> => {
        const mermaid = (await import(`mermaid`)).default;
        mermaid.initialize({ startOnLoad: false, securityLevel: `strict`, suppressErrorRendering: true, ...mermaidTheme(scheme, font) });
        const { svg } = await mermaid.render(`md-mermaid-${(ids += 1)}`, code);
        return svg;
    };
    const start = (): Promise<string> => bounded(work());
    // Both arms run `start`: one diagram's refusal must not stop the next one from being drawn.
    const next = queue.then(start, start);
    queue = next.catch(() => undefined);
    return next;
};
