import { definePreset } from "@primeuix/themes";
import Aura from "@primeuix/themes/aura";

// Bridges Tailwind and PrimeVue: PrimeVue's `--p-*` tokens point at the same CSS variables that drive Tailwind
// utilities (primitive-colors.css / semantic-colors.css), so both update from one change. Both color schemes are
// defined so light/dark is a runtime toggle, not a rebuild.
const ramp = (name: string) => ({
    50: `var(--color-${name}-50)`,
    100: `var(--color-${name}-100)`,
    200: `var(--color-${name}-200)`,
    300: `var(--color-${name}-300)`,
    400: `var(--color-${name}-400)`,
    500: `var(--color-${name}-500)`,
    600: `var(--color-${name}-600)`,
    700: `var(--color-${name}-700)`,
    800: `var(--color-${name}-800)`,
    900: `var(--color-${name}-900)`,
    950: `var(--color-${name}-950)`,
});

// Solid accent for Checkbox/RadioButton/ToggleSwitch/Slider/Tabs (buttons are overridden separately in
// primeng.css). Identical in both color-scheme blocks on purpose; the CSS variables flip, not the preset.
const accent = {
    color: `var(--color-primary-fill)`,
    contrastColor: `var(--color-fill-content)`,
    hoverColor: `var(--color-primary-fill-hover)`,
    activeColor: `var(--color-primary-fill-hover)`,
};

const custom = {
    semantic: {
        // Every Aura component's hover and focus fade (buttons, menu and list items, tabs) reads this one token; Aura's
        // 0.2s made PrimeVue a beat slower than the app's own rows and chips. motion.css owns the figure.
        transitionDuration: `var(--motion-quick)`,
        primary: ramp(`primary`),
        // Every modal's scrim, the dialog's and a bottom sheet's alike: each look answers `--ui-scrim` itself
        // (semantic-colors.css, sanctum.css). The mask arrives as a keyframe that holds its last frame, which outranks
        // any rule a skin writes for it; the token is the only way in.
        mask: { transitionDuration: `var(--motion-base)` },
        colorScheme: {
            light: {
                surface: ramp(`surface`),
                primary: accent,
                mask: { background: `var(--ui-scrim)` },
            },
            dark: {
                surface: ramp(`surface`),
                primary: accent,
                mask: { background: `var(--ui-scrim)` },
            },
        },
    },
    components: {
        // Aura drew the dialog in its own neutral greys: pure white on warm paper, the card's very value in the dark (so
        // it never rose above the cards it covered), and 40%-grey ink in the light. Each now names the app's own role;
        // the anatomy past what these tokens reach (the description, the edges a scroll shows, the sheet) is dialog.css.
        dialog: {
            root: {
                background: `var(--ui-dialog-fill)`,
                borderColor: `var(--ui-dialog-line)`,
                color: `var(--color-content)`,
                borderRadius: `var(--radius-xl)`,
                shadow: `var(--ui-shadow-3)`,
            },
            header: { padding: `var(--ui-dialog-pad) var(--ui-dialog-pad) calc(var(--spacing) * 3)`, gap: `calc(var(--spacing) * 4)` },
            title: { fontSize: `var(--text-lg)`, fontWeight: `var(--font-weight-semibold)` },
            content: { padding: `var(--spacing) var(--ui-dialog-pad) var(--ui-dialog-pad)` },
            footer: { padding: `calc(var(--spacing) * 4) var(--ui-dialog-pad) var(--ui-dialog-pad)`, gap: `calc(var(--spacing) * 2)` },
        },
        button: {
            root: {
                borderRadius: `var(--radius-md)`,
                paddingY: `var(--ui-control-padding-y)`,
                paddingX: `var(--ui-button-padding-x)`,
                iconOnlyWidth: `2.375rem`,
                // The compact button size: `size="small"` is this, so call sites don't need to override it locally.
                // `--text-2xs`'s
                // line-height is pinned separately in primeng.css, since Aura has no per-size token for it.
                sm: {
                    fontSize: `var(--text-2xs)`,
                    paddingY: `var(--spacing)`,
                    paddingX: `calc(var(--spacing) * 2.5)`,
                    iconOnlyWidth: `1.75rem`,
                },
            },
            colorScheme: {
                // Aura inks a borderless secondary button surface.500, which on light paper sits LIGHTER than the
                // `subtle` a disabled button wears (primeng.css): a row of them read as one grey, the ones that could
                // not be pressed a shade darker than the one that could, and at 4.1:1 below AA. `muted` is the step
                // above `subtle` that dark's own surface.400 already is, so dark is left as Aura has it.
                light: { text: { secondary: { color: `var(--color-muted)` } } },
            },
        },
        card: {
            root: {
                borderRadius: `var(--ui-radius)`,
            },
        },
        toggleswitch: {
            colorScheme: {
                // Aura's dark disabled state fades a track/handle pair that already blends with the surrounding card,
                // reading as missing rather than disabled.
                dark: {
                    root: { disabledBackground: `var(--color-surface-700)` },
                    handle: { disabledBackground: `var(--color-surface-500)` },
                },
            },
        },
    },
};

export const Theme = definePreset(Aura, custom) as typeof Aura & typeof custom;
