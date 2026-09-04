import { useHighlighter, useTheme } from "@intentic/ui";
import { useTextSize } from "@intentic/ui/text-size";
import type * as Monaco from "monaco-editor-core";
import { watch } from "vue";
import { toScreenPx } from "../uiScale";

/* Single Monaco integration point for the workspace code surface (CodeView + DiffView). Monaco is VSCode's
 * editor: its minimap, diff editor, find, and selection overview are built-in. It is lazy-loaded on first use
 * (the first code file / diff opened), so image/pdf/binary views never pull it into the bundle.
 *
 * Highlighting stays on Shiki: @shikijs/monaco installs the app's existing light-plus/dark-plus themes and the
 * ~40 lazily-loaded grammars as Monaco's tokenizer, so code is colored exactly like the <Code> HTML preview.
 * The one behavioral change from the old Shiki-HTML surface: Monaco holds a single active theme at a time, so a
 * light/dark toggle is monaco.editor.setTheme() + a cheap re-tokenize of visible lines (how VSCode itself works),
 * not the previous zero-JS --shiki-dark CSS flip. */

declare global {
    interface Window {
        MonacoEnvironment?: Monaco.Environment;
    }
}

type ShikiToMonaco = (typeof import("@shikijs/monaco"))["shikiToMonaco"];

type ShikiCore = Awaited<ReturnType<ReturnType<typeof useHighlighter>[`ensureCore`]>>;

// The theme Monaco should show: light-plus or dark-plus matching the active color scheme.
const activeTheme = (): string => (useTheme().scheme.value === `dark` ? `dark-plus` : `light-plus`);

const channel = (n: number): string => n.toString(16).padStart(2, `0`);

// Monaco theme colors must be concrete #rrggbb strings, they can't reference the app's oklch() vars, and
// browsers now serialize a computed color back as oklch()/color() rather than rgb(). Resolve --color-canvas
// through a color-property probe (a custom property would serialize back unresolved), then rasterize that
// value on a 1×1 canvas and read the sRGB bytes, format-agnostic, so it survives whatever string the
// browser hands back. Read live, so it reflects the active scheme and the accent the reader picked.
const resolveEditorBg = (): string => {
    const probe = document.createElement(`span`);
    probe.style.color = `var(--color-canvas)`;
    document.body.appendChild(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    const ctx = document.createElement(`canvas`).getContext(`2d`)!;
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0] = ctx.getImageData(0, 0, 1, 1).data;
    return `#${channel(r)}${channel(g)}${channel(b)}`;
};

// Pull the editor surface off Shiki dark-plus's stock #1E1E1E and onto the app's canvas token, so the
// code area is the deepest surface (a step below the bg-card chrome) in the active brand's tone. Mutating
// the theme's colors map before the bridge runs bakes the bg into the Monaco theme it defines. Only the two
// Monaco-scoped surface keys are touched, theme.bg/fg and token colors are untouched, so the shared <Code>
// HTML highlighter is unaffected.
const patchEditorSurface = (core: NonNullable<ShikiCore>): void => {
    const bg = resolveEditorBg();
    const colors = (core.getTheme(activeTheme()).colors ??= {});
    colors[`editor.background`] = bg;
    colors[`editorGutter.background`] = bg;
    /* The minimap slider is the only standing "you are here" on a surface with no scrollbar (CodeView turns the
     * vertical one off), and it is painted always rather than on hover, so it has to READ as a position marker
     * without being a stripe across the code. VSCode's stock 20% grey is tuned for a slider you only ever see
     * while pointing at it: a touch more presence here, in a neutral grey that works over both schemes. */
    colors[`minimapSlider.background`] = `#7f7f7f40`;
    colors[`minimapSlider.hoverBackground`] = `#7f7f7f59`;
    colors[`minimapSlider.activeBackground`] = `#7f7f7f73`;
};

let ready: Promise<typeof Monaco> | undefined;
let bridge: ShikiToMonaco | undefined;
// Grammars already registered with Monaco + bridged, so re-opening the same language is a no-op.
const bridged = new Set<string>();

// (Re)install the Shiki tokenizer for every currently-loaded grammar. shikiToMonaco resets the active theme to
// the first loaded theme (light-plus) on every call, so re-apply ours right after, otherwise opening a new
// language would flip a dark editor back to light.
const applyBridge = (monaco: typeof Monaco, core: NonNullable<ShikiCore>): void => {
    patchEditorSurface(core);
    bridge?.(core, monaco);
    monaco.editor.setTheme(activeTheme());
};

const init = async (): Promise<typeof Monaco> => {
    const monaco = await import(`monaco-editor-core`);
    const { default: EditorWorker } = await import(`./editorWorker?worker`);
    // Ship ONLY the editor worker, it also runs the diff algorithm. No TS/CSS/HTML language workers (Shiki
    // tokenizes, and we want no IntelliSense), which keeps the multi-MB language workers out of the build.
    // The entry is ours (editorWorker.ts) rather than monaco's own module: monaco-editor-core only EXPORTS the
    // worker's start(), never calls it, so loading it straight left the worker deaf, see that file.
    self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

    bridge = (await import(`@shikijs/monaco`)).shikiToMonaco;
    // Bridge with no grammars yet, it still defines light-plus/dark-plus and patches setTheme, so even a
    // plaintext (unsupported / oversized) file renders with the right theme background. Grammars register lazily.
    const core = await useHighlighter().ensureCore();
    applyBridge(monaco, core);
    // One active theme at a time. Re-run the bridge (not a bare setTheme) on a scheme OR accent change, so the
    // editor background is re-resolved from --color-canvas and re-baked into the now-active theme, keeping the
    // editor on the canvas token across light/dark and colour changes (module-lifetime watcher).
    const { scheme, accent } = useTheme();
    watch([scheme, accent], () => applyBridge(monaco, core));
    return monaco;
};

// Build (once) the shared Monaco namespace with workers, the Shiki bridge, and theme sync wired up.
const ensureMonaco = (): Promise<typeof Monaco> => (ready ??= init());

// Register `lang` with Monaco and load its Shiki grammar, then re-run the bridge so the newly loaded grammar
// gets a tokens provider. Returns the language Monaco can actually use: undefined / unshipped languages, and
// a grammar chunk that failed to load, fall through to plaintext. Highlighting is an enhancement over readable
// text, so a stale deploy chunk or an offline first-open must never stop a file's model from being created. The
// failed grammar is not added to `bridged`, and useHighlighter drops its rejected load, so a later open retries.
const ensureLanguage = async (monaco: typeof Monaco, lang: string | undefined): Promise<string | undefined> => {
    if (lang === undefined || bridged.has(lang)) {
        return lang;
    }
    try {
        const core = await useHighlighter().ensureLang(lang);
        if (core === undefined) {
            return undefined;
        }
        if (!monaco.languages.getLanguages().some((entry) => entry.id === lang)) {
            monaco.languages.register({ id: lang });
        }
        applyBridge(monaco, core);
        bridged.add(lang);
        return lang;
    } catch {
        return undefined;
    }
};

/* THE CODE SURFACE'S TYPE, in one place because both surfaces read from the same knob. Monaco paints its own
 * text from numbers, so unlike the rest of the app it does not follow the base text size on its own, these
 * are stated AT that size and converted, and an editor already on screen re-reads them through
 * `watchEditorType`. Without that, choosing a bigger text size left the one surface made entirely of text at
 * the old one.
 *
 * The diff is set a step TIGHTER than the file: its panes hold the same code at half the width (side-by-side)
 * and a review reads by scanning, not by settling in, so at the file's size it crowded out everything else
 * on screen. */
const TYPE_PX = {
    file: { font: 13, line: 20 },
    diff: { font: 12, line: 17 },
} as const;

export type EditorSurface = keyof typeof TYPE_PX;

export const editorType = (surface: EditorSurface = `file`): { fontSize: number; lineHeight: number } => ({
    fontSize: toScreenPx(TYPE_PX[surface].font),
    lineHeight: toScreenPx(TYPE_PX[surface].line),
});

/** Keep an editor's type current for as long as the component holding it lives. */
export const watchEditorType = (apply: (type: { fontSize: number; lineHeight: number }) => void, surface: EditorSurface = `file`): void => {
    watch(useTextSize().scale, () => apply(editorType(surface)));
};

export function useMonaco() {
    return { ensureMonaco, ensureLanguage };
}
