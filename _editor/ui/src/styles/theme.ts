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
        primary: ramp(`primary`),
        colorScheme: {
            light: {
                surface: ramp(`surface`),
                primary: accent,
            },
            dark: {
                surface: ramp(`surface`),
                primary: accent,
            },
        },
    },
    components: {
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
        },
        card: {
            root: {
                borderRadius: `var(--ui-radius)`,
            },
        },
        toggleswitch: {
            colorScheme: {
                // Aura's dark disabled state fades a track/handle pair that already blends with the surrounding card,
                // reading as
                // missing rather than disabled. Track stays at the OFF-state shade and the handle lifts to surface-500,
                // so the
                // shape survives the fade.
                dark: {
                    root: { disabledBackground: `var(--color-surface-700)` },
                    handle: { disabledBackground: `var(--color-surface-500)` },
                },
            },
        },
    },
};

export const Theme = definePreset(Aura, custom) as typeof Aura & typeof custom;
