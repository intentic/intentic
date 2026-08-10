import { useHighlighter, useTheme } from "@intentic/ui";
import { useTextSize } from "@intentic/ui/text-size";
import type * as Monaco from "monaco-editor-core";
import { watch } from "vue";
import { toScreenPx } from "../uiScale";
import { useImportedTheme } from "../theme/useImportedTheme";

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

// The stock theme for the active color scheme.
const baseTheme = (): string => (useTheme().scheme.value === `dark` ? `dark-plus` : `light-plus`);

// The theme Monaco should show: an imported VSCode theme when one is active AND actually loaded into the core
// (so a failed/absent import silently falls back to the stock theme — normal highlighting can never break here).
const shikiTheme = (core: NonNullable<ShikiCore>): string => {
    const imported = useImportedTheme().active.value;
    if (imported !== undefined && core.getLoadedThemes().includes(imported.shikiName)) {
        return imported.shikiName;
    }
    return baseTheme();
};

// Load the active import's raw VSCode theme (its `tokenColors` are the syntax colors) into the Shiki core under its
// stable name, once. Shiki consumes VSCode themes directly. Guarded: a malformed theme just doesn't apply — it
// never throws out of here, so the editor keeps tokenizing with the stock theme.
const ensureImportedTheme = async (core: NonNullable<ShikiCore>): Promise<void> => {
    const imported = useImportedTheme().active.value;
    if (imported === undefined || core.getLoadedThemes().includes(imported.shikiName)) {
        return;
    }
    try {
        await core.loadTheme({ ...imported.raw, name: imported.shikiName } as Parameters<(typeof core)[`loadTheme`]>[0]);
    } catch {
        // A bad theme JSON: leave it unloaded so shikiTheme() falls back to the stock theme.
    }
};

const channel = (n: number): string => n.toString(16).padStart(2, `0`);

// Monaco theme colors must be concrete #rrggbb strings — they can't reference the app's oklch() vars, and
// browsers now serialize a computed color back as oklch()/color() rather than rgb(). Resolve --color-canvas
// through a color-property probe (a custom property would serialize back unresolved), then rasterize that
// value on a 1×1 canvas and read the sRGB bytes — format-agnostic, so it survives whatever string the
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
// Monaco-scoped surface keys are touched — theme.bg/fg and token colors are untouched, so the shared <Code>
// HTML highlighter is unaffected.
const patchEditorSurface = (core: NonNullable<ShikiCore>): void => {
    const bg = resolveEditorBg();
    const colors = (core.getTheme(shikiTheme(core)).colors ??= {});
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
    monaco.editor.setTheme(shikiTheme(core));
};

const init = async (): Promise<typeof Monaco> => {
    const monaco = await import(`monaco-editor-core`);
    const { default: EditorWorker } = await import(`./editorWorker?worker`);
    // Ship ONLY the editor worker — it also runs the diff algorithm. No TS/CSS/HTML language workers (Shiki
    // tokenizes, and we want no IntelliSense), which keeps the multi-MB language workers out of the build.
    // The entry is ours (editorWorker.ts) rather than monaco's own module: monaco-editor-core only EXPORTS the
    // worker's start(), never calls it, so loading it straight left the worker deaf — see that file.
    self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

    bridge = (await import(`@shikijs/monaco`)).shikiToMonaco;
    // Bridge with no grammars yet — it still defines light-plus/dark-plus and patches setTheme, so even a
    // plaintext (unsupported / oversized) file renders with the right theme background. Grammars register lazily.
    const core = await useHighlighter().ensureCore();
    // Load a restored imported theme before the first bridge, so a reload lands straight on the imported syntax.
    await ensureImportedTheme(core);
    applyBridge(monaco, core);
    // One active theme at a time. Re-run the bridge (not a bare setTheme) on a scheme OR accent change, so the
    // editor background is re-resolved from --color-canvas and re-baked into the now-active theme — keeping the
    // editor on the canvas token across light/dark and colour changes (module-lifetime watcher).
    const { scheme, accent } = useTheme();
    watch([scheme, accent], () => applyBridge(monaco, core));
    /* Importing / removing a VSCode theme re-themes the editor's syntax too: load the new theme (if any), then
     * re-run the bridge so Monaco switches onto it (or falls back to the stock theme when the import is removed).
     *
     * The load is a round trip through a file, so two imports in quick succession — or an import and the removal
     * that follows it — are two of these in flight at once, and the one that happens to finish LAST is the one
     * that would paint. Re-reading the active import after the await is what settles it: a call that is no
     * longer about the current theme has nothing left to say and stands down. */
    const { active: importedTheme } = useImportedTheme();
    watch(importedTheme, async (imported) => {
        await ensureImportedTheme(core);
        if (importedTheme.value !== imported) {
            return;
        }
        applyBridge(monaco, core);
    });
    return monaco;
};

// Build (once) the shared Monaco namespace with workers, the Shiki bridge, and theme sync wired up.
const ensureMonaco = (): Promise<typeof Monaco> => (ready ??= init());

// Register `lang` with Monaco and load its Shiki grammar, then re-run the bridge so the newly loaded grammar
// gets a tokens provider. Returns the language Monaco can actually use: undefined / unshipped languages — and
// a grammar chunk that failed to load — fall through to plaintext. Highlighting is an enhancement over readable
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

/* THE CODE SURFACE'S TYPE, in one place because both surfaces are the same surface to a reader: a file and its
 * diff must not be set in different sizes. Monaco paints its own text from numbers, so unlike the rest of the
 * app it does not follow the base text size on its own — these are stated AT that size and converted, and an
 * editor already on screen re-reads them through `watchEditorType`. Without that, choosing a bigger text size
 * left the one surface made entirely of text at the old one. */
const EDITOR_FONT_PX = 13;
const EDITOR_LINE_PX = 20;

export const editorType = (): { fontSize: number; lineHeight: number } => ({
    fontSize: toScreenPx(EDITOR_FONT_PX),
    lineHeight: toScreenPx(EDITOR_LINE_PX),
});

/** Keep an editor's type current for as long as the component holding it lives. */
export const watchEditorType = (apply: (type: { fontSize: number; lineHeight: number }) => void): void => {
    watch(useTextSize().scale, () => apply(editorType()));
};

export function useMonaco() {
    return { ensureMonaco, ensureLanguage };
}
