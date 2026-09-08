import { useHighlighter, useTheme } from "@intentic/ui";
import { useTextSize } from "@intentic/ui/text-size";
import type * as Monaco from "monaco-editor-core";
import { watch } from "vue";
import { toScreenPx } from "../../../shell/window/uiScale";
import { EDITOR_ICON_CSS } from "./monacoIcons";

// Single Monaco integration point for the code surface (CodeView + DiffView), lazy-loaded on first use so other
// viewers skip it. Highlighting stays on Shiki, bridged into Monaco's tokenizer so code matches the <Code> HTML
// preview. One active theme at a time; a light/dark toggle re-tokenizes via setTheme().

declare global {
    interface Window {
        MonacoEnvironment?: Monaco.Environment;
    }
}

type ShikiToMonaco = (typeof import("@shikijs/monaco"))["shikiToMonaco"];

type ShikiCore = Awaited<ReturnType<ReturnType<typeof useHighlighter>[`ensureCore`]>>;

const activeTheme = (): string => (useTheme().scheme.value === `dark` ? `dark-plus` : `light-plus`);

const channel = (n: number): string => n.toString(16).padStart(2, `0`);

// Monaco theme colors must be concrete #rrggbb strings; oklch()/color() computed values are rasterized on a 1x1
// canvas to read sRGB bytes. Read live so it reflects the active scheme and accent.
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

// Overrides the editor/gutter background to the app's canvas token before the bridge runs, so it bakes into the
// active theme. Only those two keys are touched; token colors stay shared with the <Code> HTML highlighter.
const patchEditorSurface = (core: NonNullable<ShikiCore>): void => {
    const bg = resolveEditorBg();
    const colors = (core.getTheme(activeTheme()).colors ??= {});
    colors[`editor.background`] = bg;
    colors[`editorGutter.background`] = bg;
    // Painted always, not on hover, as the only position marker with no scrollbar.
    colors[`minimapSlider.background`] = `#7f7f7f40`;
    colors[`minimapSlider.hoverBackground`] = `#7f7f7f59`;
    colors[`minimapSlider.activeBackground`] = `#7f7f7f73`;
};

let ready: Promise<typeof Monaco> | undefined;
let bridge: ShikiToMonaco | undefined;
// Grammars already registered and bridged; re-opening the same language is a no-op.
const bridged = new Set<string>();

// (Re)installs the Shiki tokenizer for every loaded grammar. shikiToMonaco resets the active theme each call,
// so the theme is re-applied right after.
const applyBridge = (monaco: typeof Monaco, core: NonNullable<ShikiCore>): void => {
    patchEditorSurface(core);
    bridge?.(core, monaco);
    monaco.editor.setTheme(activeTheme());
};

const init = async (): Promise<typeof Monaco> => {
    const monaco = await import(`monaco-editor-core`);
    const icons = document.createElement(`style`);
    icons.dataset[`intenticEditorIcons`] = ``;
    icons.textContent = EDITOR_ICON_CSS;
    document.head.append(icons);
    const { default: EditorWorker } = await import(`./editorWorker?worker`);
    // Ships only the editor worker; no language workers. Own entry: monaco's module never calls start().
    self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

    bridge = (await import(`@shikijs/monaco`)).shikiToMonaco;
    // With no grammars loaded, the bridge still sets the themes, so even plaintext renders the right background.
    const core = await useHighlighter().ensureCore();
    applyBridge(monaco, core);
    // Reruns the bridge (not setTheme) on scheme or accent change, so the background is re-resolved and rebaked.
    const { scheme, accent } = useTheme();
    watch([scheme, accent], () => applyBridge(monaco, core));
    return monaco;
};

// Builds the shared Monaco namespace once, with workers, the Shiki bridge, and theme sync wired up.
const ensureMonaco = (): Promise<typeof Monaco> => (ready ??= init());

// Registers `lang` with Monaco, loads its grammar, and reruns the bridge for a tokens provider. An unshipped or
// failed grammar falls through to plaintext without marking it bridged, so a later open retries.
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

// Both surfaces share this; Monaco paints raw pixels, so a size change needs watchEditorType on an open editor.
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
