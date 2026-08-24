import { computed, type ComputedRef, type Ref } from "vue";
import { definePreference } from "./preference.js";

export type TextSize = "compact" | "default" | "large";

const STORAGE_KEY = `ui-text-size`;
const ATTRIBUTE = `data-text-size`;

const sizes = new Set<string>([`compact`, `default`, `large`]);

/* THE APP'S BASE TEXT SIZE, the one knob every rem in the design system hangs off, so moving it grows type,
 * padding, control heights, radii and column gutters together instead of only the words. The app ships at
 * 100% (Compact), like VS Code's default zoom — fixed until the reader opts in. `default` is 110%, the size the
 * interface was originally drawn at; `large` is 120%.
 *
 * Stated as a PERCENTAGE of the browser's base font rather than as a pixel number (tokens.css owns the actual
 * rules, keyed off this attribute): someone who has raised that base for readability keeps the gain instead of
 * having it overwritten.
 *
 * An account preference (composables/preference.ts), so it is live in every window: this one moves the whole
 * LAYOUT, so a popped-out chat left at the old size is the most visible way two windows can disagree.
 *
 * `scale` is the same multiplier as a number, for the one thing rem cannot express: a width the reader DRAGGED.
 * Those are stored as pixels at the base size (useLayout) and have to be converted to and from screen pixels at
 * the pointer, which is arithmetic, not styling. The CSS side of that conversion is `--ui-scale`. */
const SCALES: Record<TextSize, number> = { compact: 1, default: 1.1, large: 1.2 };

const isTextSize = (value: unknown): value is TextSize => typeof value === `string` && sizes.has(value);

const apply = (value: TextSize): void => {
    // Compact is the stylesheet's own `:root` value, so it is the absence of the attribute.
    if (value === `compact`) {
        document.documentElement.removeAttribute(ATTRIBUTE);
    } else {
        document.documentElement.setAttribute(ATTRIBUTE, value);
    }
};

/* The size the app opens at: whatever index.html's anti-flash script left on <html>, read ONCE before anything
 * here writes it. That script reads this same key, so with nothing stored there is no attribute either and this
 * is Compact. Captured rather than consulted on demand, for the reason useTheme's own boot value gives: after
 * the first change the attribute states what this window is SHOWING, not what is stored. */
const bootAttribute = document.documentElement.getAttribute(ATTRIBUTE);
const BOOT_SIZE: TextSize = isTextSize(bootAttribute) ? bootAttribute : `compact`;

const textSize: Ref<TextSize> = definePreference<TextSize>({
    key: STORAGE_KEY,
    read: (raw) => (isTextSize(raw) ? raw : BOOT_SIZE),
    write: (value) => value,
    apply,
});

const scale: ComputedRef<number> = computed(() => SCALES[textSize.value]);

const setTextSize = (value: TextSize): void => {
    textSize.value = value;
};

export function useTextSize() {
    return { textSize, setTextSize, scale };
}
