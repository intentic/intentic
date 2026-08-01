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
    twMerge(
        buttonBase,
        `bg-primary-fill/10 text-primary-fill border-primary-fill/20 hover:bg-primary-fill/18 hover:border-primary-fill/35`,
        ...twClasses,
    );

/** Confirming action that lands work (commit, land, apply). */
const buttonSuccess = (...twClasses: string[]) =>
    twMerge(
        buttonBase,
        `bg-success-fill/10 text-success-fill border-success-fill/20 hover:bg-success-fill/18 hover:border-success-fill/35`,
        ...twClasses,
    );

/** Destructive-but-reversible action (a checkpoint is saved first). */
const buttonWarning = (...twClasses: string[]) =>
    twMerge(
        buttonBase,
        `bg-warning-fill/10 text-warning-fill border-warning-fill/20 hover:bg-warning-fill/18 hover:border-warning-fill/35`,
        ...twClasses,
    );

/** Destructive action with no undo. */
const buttonDanger = (...twClasses: string[]) =>
    twMerge(buttonBase, `bg-danger-fill/10 text-danger-fill border-danger-fill/20 hover:bg-danger-fill/18 hover:border-danger-fill/35`, ...twClasses);

/* Bare 24px icon button — the toolbar affordance that shows no chrome until the pointer is on it. Nine of
 * these had been spelled out by hand across the terminal panel, the workspace toolbar, the history panel and
 * the two popover triggers; they agreed exactly, which is what made a tenth so easy to get slightly wrong.
 * Callers size and re-tint through twMerge (`cmp.iconButton('h-7 w-7 hover:text-danger')`). */
const iconButton = (...twClasses: string[]) =>
    twMerge(
        `flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted transition-colors hover:bg-overlay hover:text-content`,
        ...twClasses,
    );

/* Inline text button that reads as a link — a lane switch, an escape hatch, "use my own X instead". Sized
 * so a thumb can hit it (36px) while the negative margin keeps that height from showing up as a gap in the
 * card it sits in, so the same recipe is right on a phone and on a desktop. Callers restyle the text
 * (`cmp.linkButton('text-muted underline hover:text-content')` for the quieter, secondary ones). */
const linkButton = (...twClasses: string[]) =>
    twMerge(
        `-my-1.5 flex min-h-9 cursor-pointer items-center self-start text-left text-xs text-link transition-colors hover:underline`,
        ...twClasses,
    );

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

export const cmp = {
    buttonPrimary,
    buttonSuccess,
    buttonWarning,
    buttonDanger,
    iconButton,
    linkButton,
    input,
    alertDanger,
    alertWarning,
    emptyState,
    sectionLabel,
};
