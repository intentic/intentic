import { twMerge } from "tailwind-merge";

/* Centralized class-string builders — the single source of truth for repeated visual recipes.
 * Each function returns a merged Tailwind class string; callers pass overrides that twMerge
 * resolves (e.g. `cmp.input('text-2xs px-2 py-1')` shrinks the base input). No @apply, no
 * specificity issues, no !important — the caller always wins. */

/* THERE IS NO `button*` RECIPE HERE ANY MORE, and its absence is the point.
 *
 * There used to be four — buttonPrimary/Success/Warning/Danger — painting a tinted fill on a bare <button>.
 * They existed because `@layer components` in primeng.css translated only ONE of PrimeVue's severities into
 * this app's tinted language, leaving success/warn/danger as Aura's solid fills; with no way to write a tinted
 * destructive button as a <Button>, the recipes were written here instead. The result was two action buttons
 * that looked alike, sized differently (text-xs at py-1 here, text-sm at py-1.5 there) and were chosen between
 * arbitrarily — 201 <Button> against 31 of these, sometimes both in one header.
 *
 * primeng.css now tints every solid severity, so `<Button severity="danger">` IS what buttonDanger drew. One
 * action button: <Button>, with `severity` for tone and `class` for geometry.
 *
 * The two recipes below STAY. They are not tones of the action button, they are different tiers with their own
 * behaviour — no chrome until hover, a 36px thumb target on an inline text action — and both are used
 * consistently wherever they appear, which is what a working distinction looks like. */

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

/** Inline informational alert banner — a notice the user does not have to act on. */
const alertInfo = (...twClasses: string[]) => twMerge(`rounded-lg border border-info/40 bg-info/10 px-3 py-2 text-xs text-info`, ...twClasses);

/** Dashed-border "nothing here yet" empty state placeholder. */
const emptyState = (...twClasses: string[]) =>
    twMerge(`rounded-lg border border-dashed border-line px-3 py-4 text-center text-xs text-muted`, ...twClasses);

/** Uppercase section heading label (e.g. "CONNECTIONS", "YOUR APPS"). */
const sectionLabel = (...twClasses: string[]) => twMerge(`text-xs font-semibold uppercase tracking-wide text-subtle`, ...twClasses);

export const cmp = {
    iconButton,
    linkButton,
    input,
    alertDanger,
    alertWarning,
    alertInfo,
    emptyState,
    sectionLabel,
};
