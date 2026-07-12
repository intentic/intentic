import { twMerge } from "tailwind-merge";

/* Centralized class-string builders — the single source of truth for repeated visual recipes.
 * Each function returns a merged Tailwind class string; callers pass overrides that twMerge
 * resolves (e.g. `cmp.input('text-2xs px-2 py-1')` shrinks the base input). No @apply, no
 * specificity issues, no !important — the caller always wins. */

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

export const cmp = { input, alertDanger, alertWarning, emptyState, sectionLabel };
