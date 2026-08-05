import { definePreset } from "@primeuix/themes";
import Aura from "@primeuix/themes/aura";

/* The bridge that makes Tailwind and PrimeVue one system: PrimeVue's `--p-*` design tokens
 * are pointed at the SAME CSS variables that drive the Tailwind utilities (defined in
 * primitive-colors.css / semantic-colors.css). Change a palette there and both worlds
 * update together. Both color schemes are defined so light/dark is a runtime toggle
 * (see useTheme), not a rebuild. */
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

/* Every solid PrimeVue accent — Checkbox, RadioButton, ToggleSwitch, Slider, Tabs — paints with
 * `primary.color` and labels with `primary.contrastColor`. The fill tokens flip per scheme and
 * clear WCAG AA for these solid-accent controls. Buttons are overridden separately in primeng.css
 * to use a tinted fill instead, so the accent here no longer drives button appearance.
 * Identical in both blocks on purpose — the CSS variable does the flipping, not the preset. */
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
                paddingX: `var(--ui-control-padding-x)`,
                iconOnlyWidth: `2.375rem`,
                sm: {
                    paddingY: `calc(var(--spacing) * 1.5)`,
                    paddingX: `calc(var(--spacing) * 2.5)`,
                    iconOnlyWidth: `2.125rem`,
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
                // Aura's dark disabled state pairs a surface-600 track with a surface-900 handle — a knob the
                // same value as the card it sits on — and then fades the whole control to 0.6. The switch
                // doesn't read as "disabled", it reads as MISSING: an empty gap where a control was. Any
                // moment a toggle is briefly disabled (settings still loading, sandbox offline) therefore
                // looks like the UI dropped it. Hold the track at the same shade as the OFF state and lift the
                // handle to surface-500, so the shape survives the fade and only its contrast drops.
                dark: {
                    root: { disabledBackground: `var(--color-surface-700)` },
                    handle: { disabledBackground: `var(--color-surface-500)` },
                },
            },
        },
    },
};

export const Theme = definePreset(Aura, custom) as typeof Aura & typeof custom;
