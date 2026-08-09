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

/* One diagram's SVG markup, or a rejection when mermaid will not draw it (invalid syntax, or a diagram type
 * this build does not know) — the caller shows the source instead.
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
    // Both arms run `work`: one diagram's refusal must not stop the next one from being drawn.
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
};
