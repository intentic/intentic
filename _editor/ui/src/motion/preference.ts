import { computed, type ComputedRef, type Ref, ref, watch } from "vue";
import { definePreference } from "../composables/preference.js";

// WHETHER THE INTERFACE MOVES, as one answer for the whole window. The reader picks `on` or `off` in Appearance, or
// leaves it at `system`, where the OS's reduce-motion switch decides. The resolved answer is written to <html> as
// `data-motion="reduced"` (absent means full motion), and that attribute is what every stylesheet reads: motion.css
// zeroes the duration tokens and stills every transition under it, so a component never asks for itself. The few
// moves played from script (the board's folds and flights) ask `lessMotion()` below before they start.

export type MotionChoice = "system" | "on" | "off";

/** The three positions of the Appearance row, in the order it draws them. */
export const MOTION_CHOICES: readonly MotionChoice[] = [`system`, `on`, `off`];

const STORAGE_KEY = `ui-motion`;
const ATTRIBUTE = `data-motion`;
export const REDUCE_MOTION_QUERY = `(prefers-reduced-motion: reduce)`;

/** Reads what storage holds (or nothing) as a choice; anything else is no choice, which `read` answers with `system`. */
export const isMotionChoice = (raw: string | null): raw is MotionChoice => raw === `system` || raw === `on` || raw === `off`;

/** The rule in one place: `off` is off, `on` is on whatever the OS says, and `system` is the OS's answer. */
export const resolveReducedMotion = (choice: MotionChoice, osReduces: boolean): boolean => choice === `off` || (choice === `system` && osReduces);

// The OS's answer, live, bound once for the window like useTheme's scheme query.
const reduceQuery = `matchMedia` in globalThis ? globalThis.matchMedia(REDUCE_MOTION_QUERY) : undefined;
// allow(module-state): the OS's one reduce-motion answer for the window, not about a sandbox.
const osReduces = ref(reduceQuery?.matches === true);
reduceQuery?.addEventListener(`change`, (event) => {
    osReduces.value = event.matches;
});

// `system` is stored as nothing, so clearing the key is how a reader goes back to following the OS.
const choice: Ref<MotionChoice> = definePreference<MotionChoice>({
    key: STORAGE_KEY,
    read: (raw) => (isMotionChoice(raw) ? raw : `system`),
    write: (value) => (value === `system` ? null : value),
});

const reduced: ComputedRef<boolean> = computed(() => resolveReducedMotion(choice.value, osReduces.value));

const apply = (less: boolean): void => {
    if (!(`document` in globalThis)) {
        return;
    }
    if (less) {
        document.documentElement.setAttribute(ATTRIBUTE, `reduced`);
    } else {
        document.documentElement.removeAttribute(ATTRIBUTE);
    }
};

// Off the RESOLVED answer, so an OS flip under `system` reaches the page too. `sync`, so no frame moves after the
// reader said stop.
watch(reduced, apply, { immediate: true, flush: `sync` });

const setMotion = (value: MotionChoice): void => {
    choice.value = value;
};

/** The stored choice, read without holding a ref: for a hook that asks once, at the moment it is about to move. */
export const motionChoice = (): MotionChoice => choice.value;

/**
 * Whether a move about to be played from script should be skipped, asked at the moment it starts. Reads the OS afresh
 * rather than through the bound query, so a page whose `matchMedia` was swapped (a test DOM) is answered by the new one.
 */
export const lessMotion = (): boolean => {
    const asked = `matchMedia` in globalThis ? globalThis.matchMedia(REDUCE_MOTION_QUERY) : undefined;
    return resolveReducedMotion(choice.value, asked?.matches === true);
};

export function useMotion() {
    return { motion: choice, setMotion, reduced };
}
