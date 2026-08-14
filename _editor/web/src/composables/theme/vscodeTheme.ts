/* Import a VSCode / OpenVSX color theme into Intentic's design tokens — the biggest familiarity lever (themes are
 * the #1 switch-blocker) and nearly pure data. A VSCode theme JSON has two halves: `colors` (workbench/editor UI
 * colors) and `tokenColors` (TextMate syntax scopes). Syntax is the easy half — Shiki consumes VSCode `tokenColors`
 * natively — so THIS module does the hard, valuable half: mapping the ~13 workbench colors that carry a theme's
 * visual identity onto the app's semantic CSS variables (`--color-canvas`, `--color-content`, `--color-line`, …).
 *
 * Everything here is pure and unit-tested; wiring the result into the live app (writing the tokens over the
 * picked accent's ramps + feeding `tokenColors` to Shiki/Monaco) is the follow-on. The one piece of real rigor is
 * color handling: VSCode colors are `#RGB[A]` / `#RRGGBB[AA]`, and borders/hovers are frequently ALPHA'd
 * (`#ffffff0a`), so a naive alpha-strip yields the wrong solid — we composite over the resolved canvas instead. */

export interface Rgb {
    readonly r: number;
    readonly g: number;
    readonly b: number;
}
export interface Rgba extends Rgb {
    // 0..1
    readonly a: number;
}

const HEX = /^#?([0-9a-fA-F]{3,8})$/;

// Parse #RGB, #RGBA, #RRGGBB, #RRGGBBAA. Returns undefined for anything else (named colors, gradients, junk).
export const parseHexColor = (input: string): Rgba | undefined => {
    const match = HEX.exec(input.trim());
    if (match === null) {
        return undefined;
    }
    const hex = match[1];
    if (hex === undefined) {
        return undefined;
    }
    const len = hex.length;
    if (len !== 3 && len !== 4 && len !== 6 && len !== 8) {
        return undefined;
    }
    const short = len === 3 || len === 4;
    // charAt/slice always return a string, so a short form doubles one nibble and a long form takes a byte pair.
    const at = (index: number): number => Number.parseInt(short ? hex.charAt(index).repeat(2) : hex.slice(index * 2, index * 2 + 2), 16);
    const hasAlpha = len === 4 || len === 8;
    return { r: at(0), g: at(1), b: at(2), a: hasAlpha ? at(3) / 255 : 1 };
};

// Alpha-composite a (possibly translucent) foreground over an opaque background — the "source-over" formula.
export const compositeOver = (fg: Rgba, bg: Rgb): Rgb => ({
    r: Math.round(fg.r * fg.a + bg.r * (1 - fg.a)),
    g: Math.round(fg.g * fg.a + bg.g * (1 - fg.a)),
    b: Math.round(fg.b * fg.a + bg.b * (1 - fg.a)),
});

const clamp = (value: number): number => Math.max(0, Math.min(255, Math.round(value)));
const toHex = (color: Rgb): string => `#${[color.r, color.g, color.b].map((channel) => clamp(channel).toString(16).padStart(2, `0`)).join(``)}`;

// Perceived luminance (0..1) — used to guess light vs dark when the theme omits `type`.
const luminance = (color: Rgb): number => (0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b) / 255;

export type ThemeMode = "dark" | "light";

export interface VscodeTheme {
    readonly type?: string;
    readonly colors?: Readonly<Record<string, string>>;
    // tokenColors is handled by Shiki, not here — declared so callers can pass a whole theme through.
    readonly tokenColors?: unknown;
}

export interface ImportedTheme {
    readonly mode: ThemeMode;
    // Full CSS variable name (e.g. "--color-canvas") → concrete "#rrggbb".
    readonly tokens: Readonly<Record<string, string>>;
}

// The identity token set — the ~13 CSS variables that carry a theme's visual identity. A single `as const` source
// so the DEFAULTS table is provably total (every token has a fallback, no non-null assertions) AND consumers can
// iterate the exact set to apply/remove overrides (the import UI reverts by removing these).
export const THEME_TOKEN_VARS = [
    `--color-canvas`,
    `--color-content`,
    `--color-card`,
    `--color-muted`,
    `--color-subtle`,
    `--color-line`,
    `--color-line-strong`,
    `--color-overlay`,
    `--color-link`,
    `--color-primary-500`,
    `--color-danger`,
    `--color-warning`,
    `--color-success`,
] as const;
type TokenVar = (typeof THEME_TOKEN_VARS)[number];

// Canvas resolves first (it's the backdrop every translucent color composites over), so its source keys are named.
const CANVAS_KEYS = [`editor.background`, `editorPane.background`] as const;

// Each app token, resolved from the FIRST present VSCode color key in its list (VSCode themes are sparse, so every
// token needs a chain of fallbacks).
const TOKEN_SOURCES: ReadonlyArray<readonly [cssVar: TokenVar, keys: readonly string[]]> = [
    [`--color-canvas`, CANVAS_KEYS],
    [`--color-content`, [`editor.foreground`, `foreground`]],
    [`--color-card`, [`sideBar.background`, `editorWidget.background`, `panel.background`]],
    [`--color-muted`, [`descriptionForeground`, `disabledForeground`]],
    [`--color-subtle`, [`input.placeholderForeground`, `disabledForeground`]],
    [`--color-line`, [`panel.border`, `editorGroup.border`, `widget.border`, `contrastBorder`]],
    [`--color-line-strong`, [`contrastBorder`, `focusBorder`]],
    [`--color-overlay`, [`list.hoverBackground`, `toolbar.hoverBackground`, `list.inactiveSelectionBackground`]],
    [`--color-link`, [`textLink.foreground`, `editorLink.activeForeground`]],
    [`--color-primary-500`, [`focusBorder`, `button.background`, `activityBarBadge.background`, `progressBar.background`]],
    [`--color-danger`, [`editorError.foreground`, `errorForeground`]],
    [`--color-warning`, [`editorWarning.foreground`, `list.warningForeground`]],
    [`--color-success`, [`terminal.ansiGreen`, `gitDecoration.addedResourceForeground`]],
];

// Sensible defaults per mode so a sparse theme still yields a COMPLETE token set (no half-styled UI). Values are
// the app's own dark/light neighbourhood, not a specific brand.
const DEFAULTS: Record<ThemeMode, Record<TokenVar, Rgb>> = {
    dark: {
        "--color-canvas": { r: 0x0b, g: 0x0d, b: 0x10 },
        "--color-content": { r: 0xe6, g: 0xe8, b: 0xeb },
        "--color-card": { r: 0x15, g: 0x18, b: 0x1c },
        "--color-muted": { r: 0x9a, g: 0xa0, b: 0xa6 },
        "--color-subtle": { r: 0x6b, g: 0x70, b: 0x76 },
        "--color-line": { r: 0x2a, g: 0x2f, b: 0x36 },
        "--color-line-strong": { r: 0x3a, g: 0x41, b: 0x4a },
        "--color-overlay": { r: 0x1e, g: 0x22, b: 0x27 },
        "--color-link": { r: 0x8a, g: 0xb4, b: 0xf8 },
        "--color-primary-500": { r: 0x4c, g: 0x8d, b: 0xf6 },
        "--color-danger": { r: 0xf8, g: 0x71, b: 0x71 },
        "--color-warning": { r: 0xe5, g: 0xa5, b: 0x4b },
        "--color-success": { r: 0x4a, g: 0xd0, b: 0x8c },
    },
    light: {
        "--color-canvas": { r: 0xff, g: 0xff, b: 0xff },
        "--color-content": { r: 0x1a, g: 0x1d, b: 0x21 },
        "--color-card": { r: 0xf5, g: 0xf6, b: 0xf8 },
        "--color-muted": { r: 0x5c, g: 0x63, b: 0x6b },
        "--color-subtle": { r: 0x8a, g: 0x90, b: 0x98 },
        "--color-line": { r: 0xe2, g: 0xe5, b: 0xe9 },
        "--color-line-strong": { r: 0xc7, g: 0xcc, b: 0xd2 },
        "--color-overlay": { r: 0xf0, g: 0xf1, b: 0xf3 },
        "--color-link": { r: 0x1a, g: 0x66, b: 0xe0 },
        "--color-primary-500": { r: 0x2a, g: 0x6a, b: 0xe0 },
        "--color-danger": { r: 0xd1, g: 0x3a, b: 0x3a },
        "--color-warning": { r: 0xb5, g: 0x7a, b: 0x1a },
        "--color-success": { r: 0x1a, g: 0x8a, b: 0x55 },
    },
};

export const vscodeThemeToTokens = (theme: VscodeTheme): ImportedTheme => {
    const colors = theme.colors ?? {};
    const resolve = (keys: readonly string[]): Rgba | undefined => {
        for (const key of keys) {
            const raw = colors[key];
            if (raw !== undefined) {
                const parsed = parseHexColor(raw);
                if (parsed !== undefined) {
                    return parsed;
                }
            }
        }
        return undefined;
    };

    // Canvas first: it's both a token and the backdrop every translucent color composites over.
    const canvasRaw = resolve(CANVAS_KEYS);
    const declaredMode: ThemeMode | undefined = theme.type === `light` ? `light` : theme.type === `dark` ? `dark` : undefined;
    const mode: ThemeMode = declaredMode ?? (canvasRaw !== undefined && luminance(canvasRaw) > 0.5 ? `light` : `dark`);
    const canvas: Rgb = canvasRaw !== undefined ? compositeOver(canvasRaw, DEFAULTS[mode][`--color-canvas`]) : DEFAULTS[mode][`--color-canvas`];

    const tokens: Record<string, string> = {};
    for (const [cssVar, keys] of TOKEN_SOURCES) {
        if (cssVar === `--color-canvas`) {
            tokens[cssVar] = toHex(canvas);
            continue;
        }
        const resolved = resolve(keys);
        tokens[cssVar] = toHex(resolved !== undefined ? compositeOver(resolved, canvas) : DEFAULTS[mode][cssVar]);
    }
    return { mode, tokens };
};
