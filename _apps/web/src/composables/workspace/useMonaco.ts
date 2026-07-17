import { useHighlighter, useTheme } from "@intentic-app/ui";
import type * as Monaco from "monaco-editor-core";
import { watch } from "vue";

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

const shikiTheme = (): string => (useTheme().scheme.value === `dark` ? `dark-plus` : `light-plus`);

const channel = (n: number): string => n.toString(16).padStart(2, `0`);

// Monaco theme colors must be concrete #rrggbb strings — they can't reference the app's oklch() vars, and
// browsers now serialize a computed color back as oklch()/color() rather than rgb(). Resolve --color-canvas
// through a color-property probe (a custom property would serialize back unresolved), then rasterize that
// value on a 1×1 canvas and read the sRGB bytes — format-agnostic, so it survives whatever string the
// browser hands back. Read live, so it reflects the active data-mode + data-theme.
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
// Monaco-scoped surface keys are touched — theme.bg/fg and token colors are untouched, so the shared <Code>
// HTML highlighter is unaffected.
const patchEditorSurface = (core: NonNullable<ShikiCore>): void => {
    const bg = resolveEditorBg();
    const colors = (core.getTheme(shikiTheme()).colors ??= {});
    colors[`editor.background`] = bg;
    colors[`editorGutter.background`] = bg;
};

let ready: Promise<typeof Monaco> | undefined;
let bridge: ShikiToMonaco | undefined;
// Grammars already registered with Monaco + bridged, so re-opening the same language is a no-op.
const bridged = new Set<string>();

// (Re)install the Shiki tokenizer for every currently-loaded grammar. shikiToMonaco resets the active theme to
// the first loaded theme (light-plus) on every call, so re-apply ours right after — otherwise opening a new
// language would flip a dark editor back to light.
const applyBridge = (monaco: typeof Monaco, core: NonNullable<ShikiCore>): void => {
    patchEditorSurface(core);
    bridge?.(core, monaco);
    monaco.editor.setTheme(shikiTheme());
};

const init = async (): Promise<typeof Monaco> => {
    const monaco = await import(`monaco-editor-core`);
    const { default: EditorWorker } = await import(`monaco-editor-core/esm/vs/editor/editor.worker.start?worker`);
    // Ship ONLY the editor worker — it also runs the diff algorithm. No TS/CSS/HTML language workers (Shiki
    // tokenizes, and we want no IntelliSense), which keeps the multi-MB language workers out of the build.
    self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

    bridge = (await import(`@shikijs/monaco`)).shikiToMonaco;
    // Bridge with no grammars yet — it still defines light-plus/dark-plus and patches setTheme, so even a
    // plaintext (unsupported / oversized) file renders with the right theme background. Grammars register lazily.
    const core = await useHighlighter().ensureCore();
    applyBridge(monaco, core);
    // One active theme at a time. Re-run the bridge (not a bare setTheme) on a scheme OR brand-theme change,
    // so the editor background is re-resolved from --color-canvas and re-baked into the now-active theme —
    // keeping the editor on the canvas token across light/dark and brand switches (module-lifetime watcher).
    const { scheme, theme } = useTheme();
    watch([scheme, theme], () => applyBridge(monaco, core));
    return monaco;
};

// Build (once) the shared Monaco namespace with workers, the Shiki bridge, and theme sync wired up.
const ensureMonaco = (): Promise<typeof Monaco> => (ready ??= init());

// Register `lang` with Monaco and load its Shiki grammar, then re-run the bridge so the newly loaded grammar
// gets a tokens provider. undefined / unshipped languages fall through to Monaco's plaintext (no coloring).
const ensureLanguage = async (monaco: typeof Monaco, lang: string | undefined): Promise<void> => {
    if (lang === undefined || bridged.has(lang)) {
        return;
    }
    const core = await useHighlighter().ensureLang(lang);
    if (core === undefined) {
        return;
    }
    if (!monaco.languages.getLanguages().some((entry) => entry.id === lang)) {
        monaco.languages.register({ id: lang });
    }
    applyBridge(monaco, core);
    bridged.add(lang);
};

export function useMonaco() {
    return { ensureMonaco, ensureLanguage };
}
