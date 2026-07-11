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

const custom = {
    semantic: {
        primary: ramp(`primary`),
        colorScheme: {
            light: {
                surface: ramp(`surface`),
            },
            dark: {
                surface: ramp(`surface`),
            },
        },
    },
    components: {
        button: {
            root: {
                borderRadius: `var(--radius-md)`,
                paddingY: `var(--ui-control-padding-y)`,
                paddingX: `calc(var(--ui-control-padding-x) * 1.25)`,
                iconOnlyWidth: `2.375rem`,
                sm: {
                    paddingY: `calc(var(--spacing) * 1.5)`,
                    paddingX: `calc(var(--spacing) * 2.5)`,
                    iconOnlyWidth: `2.125rem`,
                },
            },
            colorScheme: {
                // Aura darkens buttons toward black on hover, which vanishes against the
                // surface-950 canvas — lighten to primary-500. Set the border to the same
                // shade as the fill so no mismatched 1px ring animates in (reads as a flicker).
                dark: {
                    root: {
                        primary: {
                            hoverBackground: `var(--color-primary-500)`,
                            hoverBorderColor: `var(--color-primary-500)`,
                        },
                    },
                },
            },
        },
        card: {
            root: {
                borderRadius: `var(--ui-radius)`,
            },
        },
        tooltip: {
            root: {
                // Shrink the box to match the smaller text-xs label (≈ py-1 px-2).
                padding: `calc(var(--spacing) * 1) calc(var(--spacing) * 2)`,
            },
        },
    },
};

export const Theme = definePreset(Aura, custom) as typeof Aura & typeof custom;
