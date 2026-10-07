import { PAGE_FALLBACK_THEMES, type PageTheme, type PageThemeVariable } from "@intentic/sandbox-contract";
import { computed, type ComputedRef, shallowRef } from "vue";

// The theme a page the agent shows wears: the editor's own look, read off its live roles, so a chart sits in the chat
// in the chat's colours and follows a light/dark switch, an accent change or a skin while it stays open. Resolved to
// concrete colours here, since a page's frame has none of the editor's variables to resolve them against.

// Each page variable, by the editor role it is read from (ui/styles/semantic-colors.css).
const ROLES: Partial<Readonly<Record<PageThemeVariable, string>>> = {
    "--background": `--color-canvas`,
    "--foreground": `--color-content`,
    "--card": `--color-card`,
    "--card-foreground": `--color-content`,
    "--muted": `--color-overlay`,
    "--muted-foreground": `--color-muted`,
    "--border": `--color-line`,
    "--input": `--color-line-strong`,
    "--ring": `--color-link`,
    "--primary": `--color-primary-fill`,
    "--primary-foreground": `--color-fill-content`,
    "--accent": `--color-link`,
    "--accent-foreground": `--color-fill-content`,
    "--success": `--color-success`,
    "--warning": `--color-warning`,
    "--danger": `--color-danger`,
    "--info": `--color-info`,
    "--chart-1": `--color-series-1`,
    "--chart-2": `--color-series-2`,
    "--chart-3": `--color-series-3`,
    "--chart-4": `--color-series-4`,
    "--chart-5": `--color-series-5`,
    "--code-background": `--color-overlay`,
};

// Read straight off the root, as the editor sets them (ui/styles/tokens.css).
const FONTS: Partial<Readonly<Record<PageThemeVariable, string>>> = {
    "--font-sans": `--font-sans`,
    "--font-mono": `--font-mono`,
};

// Bumped whenever <html> changes what the roles resolve to: the scheme (`data-mode`), the accent (inline custom
// properties) or a skin (its class or data attributes). One observer for every page in every chat.
// allow(module-state): the editor's own appearance, which no sandbox switch changes
const look = shallowRef(0);
let watching = false;
const watchLook = (): void => {
    if (watching || typeof MutationObserver === `undefined` || typeof document === `undefined`) {
        return;
    }
    watching = true;
    new MutationObserver(() => {
        look.value += 1;
    }).observe(document.documentElement, { attributes: true, attributeFilter: [`data-mode`, `style`, `class`, `data-skin`, `data-look`] });
};

// The theme as the editor stands now, a fallback colour wherever a role does not resolve.
export const currentPageTheme = (): PageTheme => {
    const appearance = document.documentElement.getAttribute(`data-mode`) === `dark` ? `dark` : `light`;
    const variables: Record<PageThemeVariable, string> = { ...PAGE_FALLBACK_THEMES[appearance].variables };
    const probe = document.createElement(`span`);
    probe.style.display = `none`;
    document.body.append(probe);
    try {
        for (const [name, role] of Object.entries(ROLES) as [PageThemeVariable, string][]) {
            probe.style.color = ``;
            probe.style.color = `var(${role})`;
            const colour = getComputedStyle(probe).color;
            if (colour !== `` && colour !== `rgba(0, 0, 0, 0)`) {
                variables[name] = colour;
            }
        }
    } finally {
        probe.remove();
    }
    const root = getComputedStyle(document.documentElement);
    for (const [name, property] of Object.entries(FONTS) as [PageThemeVariable, string][]) {
        const value = root.getPropertyValue(property).trim();
        if (value !== ``) {
            variables[name] = value;
        }
    }
    return { appearance, variables };
};

// The live theme, recomputed on every change to the editor's look.
export const usePageTheme = (): ComputedRef<PageTheme> => {
    watchLook();
    return computed(() => {
        void look.value;
        return currentPageTheme();
    });
};
