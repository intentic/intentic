import { computed, ref, type ComputedRef, type Ref } from "vue";

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
 * `scale` is the same multiplier as a number, for the one thing rem cannot express: a width the reader DRAGGED.
 * Those are stored as pixels at the base size (useLayout) and have to be converted to and from screen pixels at
 * the pointer, which is arithmetic, not styling. The CSS side of that conversion is `--ui-scale`. */
const SCALES: Record<TextSize, number> = { compact: 1, default: 1.1, large: 1.2 };

const isTextSize = (value: unknown): value is TextSize => typeof value === `string` && sizes.has(value);

const read = (): TextSize => {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (isTextSize(stored)) {
            return stored;
        }
    } catch {
        // Storage may be unavailable (private mode); fall back to the attribute.
    }
    const attribute = document.documentElement.getAttribute(ATTRIBUTE);
    if (attribute === null || attribute === `compact`) {
        return `compact`;
    }
    return isTextSize(attribute) ? attribute : `compact`;
};

const apply = (value: TextSize): void => {
    // Compact is the stylesheet's own `:root` value, so it is the absence of the attribute.
    if (value === `compact`) {
        document.documentElement.removeAttribute(ATTRIBUTE);
    } else {
        document.documentElement.setAttribute(ATTRIBUTE, value);
    }
};

const textSize: Ref<TextSize> = ref(read());
apply(textSize.value); // restore the saved size when the design system loads (index.html only beats the flash)

const scale: ComputedRef<number> = computed(() => SCALES[textSize.value]);

const setTextSize = (value: TextSize): void => {
    textSize.value = value;
    apply(value);
    try {
        localStorage.setItem(STORAGE_KEY, value);
    } catch {
        // Storage may be unavailable (private mode); the in-memory ref still holds.
    }
};

export function useTextSize() {
    return { textSize, setTextSize, scale };
}
