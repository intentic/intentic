import { twMerge } from "tailwind-merge";

/* Centralized class-string builders — the single source of truth for repeated visual recipes.
 * Each function returns a merged Tailwind class string; callers pass overrides that twMerge
 * resolves (e.g. `cmp.input('text-2xs px-2 py-1')` shrinks the base input). No @apply, no
 * specificity issues, no !important — the caller always wins. */

/* Solid action buttons — the hand-rolled counterpart of PrimeVue's <Button>, for the dense spots
 * where a full component is too heavy. Both resolve to the SAME `*-fill` tokens (see theme.ts), so
 * a filled button looks identical whichever way it was built. Callers size and position it
 * (`buttonPrimary('px-2.5 py-1 text-2xs')`); they must not recolor it — the fill/label pair is what
 * carries the WCAG AA contrast, in both color schemes and all four themes. */
const buttonBase =
    `inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium ` +
    `text-fill-content transition-colors disabled:cursor-default disabled:opacity-40`;

/** Primary call to action — one per view. */
const buttonPrimary = (...twClasses: string[]) => twMerge(buttonBase, `bg-primary-fill hover:bg-primary-fill-hover`, ...twClasses);

/** Confirming action that lands work (commit, land, apply). */
const buttonSuccess = (...twClasses: string[]) => twMerge(buttonBase, `bg-success-fill hover:bg-success-fill-hover`, ...twClasses);

/** Destructive-but-reversible action (a checkpoint is saved first). */
const buttonWarning = (...twClasses: string[]) => twMerge(buttonBase, `bg-warning-fill hover:bg-warning-fill-hover`, ...twClasses);

/** Destructive action with no undo. */
const buttonDanger = (...twClasses: string[]) => twMerge(buttonBase, `bg-danger-fill hover:bg-danger-fill-hover`, ...twClasses);

/** Standard form input (text, password, number, datetime-local, textarea). */
const input = (...twClasses: string[]) =>
    twMerge(
        `rounded-md border border-line bg-canvas px-3 py-2 text-sm text-content`,
        `placeholder:text-subtle hover:border-line-strong focus:border-line-strong focus:outline-none`,
        ...twClasses,
    );

/** Inline danger alert banner. */
const alertDanger = (...twClasses: string[]) =>
    twMerge(`rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger`, ...twClasses);

/** Inline warning alert banner. */
const alertWarning = (...twClasses: string[]) =>
    twMerge(`rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning`, ...twClasses);

/** Dashed-border "nothing here yet" empty state placeholder. */
const emptyState = (...twClasses: string[]) =>
    twMerge(`rounded-lg border border-dashed border-line px-3 py-4 text-center text-xs text-muted`, ...twClasses);

/** Uppercase section heading label (e.g. "CONNECTIONS", "YOUR APPS"). */
const sectionLabel = (...twClasses: string[]) => twMerge(`text-xs font-semibold uppercase tracking-wide text-subtle`, ...twClasses);

export const cmp = { buttonPrimary, buttonSuccess, buttonWarning, buttonDanger, input, alertDanger, alertWarning, emptyState, sectionLabel };
