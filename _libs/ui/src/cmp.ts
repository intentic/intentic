import { twMerge } from "tailwind-merge";

/* Centralized class-string builders — the single source of truth for repeated visual recipes.
 * Each function returns a merged Tailwind class string; callers pass overrides that twMerge
 * resolves (e.g. `cmp.input('text-2xs px-2 py-1')` shrinks the base input). No @apply, no
 * specificity issues, no !important — the caller always wins. */

/* Tinted action buttons — a low-opacity brand tint with brand-colored text and a subtle border,
 * matching the app's established `color-mix` / `composer-active` visual language. The tint is
 * just strong enough to read as an action without competing with content. Callers size and
 * position it (`buttonPrimary('px-2 py-1 text-2xs')`); they must not recolor it. */
const buttonBase =
    `inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium ` +
    `transition-colors disabled:cursor-default disabled:opacity-40`;

/** Primary call to action — one per view. */
const buttonPrimary = (...twClasses: string[]) =>
    twMerge(buttonBase, `bg-primary-fill/10 text-primary-fill border-primary-fill/20 hover:bg-primary-fill/18 hover:border-primary-fill/35`, ...twClasses);

/** Confirming action that lands work (commit, land, apply). */
const buttonSuccess = (...twClasses: string[]) =>
    twMerge(buttonBase, `bg-success-fill/10 text-success-fill border-success-fill/20 hover:bg-success-fill/18 hover:border-success-fill/35`, ...twClasses);

/** Destructive-but-reversible action (a checkpoint is saved first). */
const buttonWarning = (...twClasses: string[]) =>
    twMerge(buttonBase, `bg-warning-fill/10 text-warning-fill border-warning-fill/20 hover:bg-warning-fill/18 hover:border-warning-fill/35`, ...twClasses);

/** Destructive action with no undo. */
const buttonDanger = (...twClasses: string[]) =>
    twMerge(buttonBase, `bg-danger-fill/10 text-danger-fill border-danger-fill/20 hover:bg-danger-fill/18 hover:border-danger-fill/35`, ...twClasses);

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
