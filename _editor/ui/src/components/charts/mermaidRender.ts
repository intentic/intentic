import { mermaidTheme } from "./mermaidTheme.js";

// One shared mermaid module: config, measuring area, and diagram registry are singletons, but a page can hold several
// diagrams. Owns the id counter (per-instance would collide across diagrams), keeps initialize+render atomic so a theme
// flip can't land between them, and lazy-imports the megabyte library.

let ids = 0;
let queue: Promise<unknown> = Promise.resolve();

// Deadline so a hung import or layout can't strand the diagram in "not yet" or block the queue behind it.
const DRAW_BUDGET_MS = 15_000;

// A timed-out render may still finish after `bounded` returns; deliberate, since unblocking the queue for the rest of
// the page matters more than that stale result.
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

// Resolves to SVG or rejects (bad syntax, unknown diagram type, or the deadline); caller falls back to source. `strict`
// sanitizes labels like surrounding prose; `suppressErrorRendering` turns mermaid's own error card into a rejection.
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
