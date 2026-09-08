// Answers "is this the current page or section" once for every nav surface (bar, phone overlay), so they cannot
// disagree. A trailing slash is never part of the comparison.
import type { MenuItem, NavEntry } from "@intentic/site-content/nav";

const bare = (path: string): string => path.replace(/\/+$/u, "");

/**
 * A bar label is current for its whole prefix region, not just one page; a menu carries several prefixes since it can
 * gather multiple sections, while a plain link is one path.
 */
export function isCurrentSection(entry: NavEntry, path: string): boolean {
    if (entry.type === "link") {
        return path === entry.href || path.startsWith(entry.prefix);
    }
    return entry.prefixes.some((prefix) => path.startsWith(prefix));
}

/**
 * A menu row is current on its own page and every page its shelf covers (`covers` in `bookDestinations`); a row without
 * a shelf falls back to just itself.
 */
export function isCurrentRow(item: MenuItem, path: string): boolean {
    const here = bare(path);
    return bare(item.href) === here || (item.covers?.some((page) => bare(page) === here) ?? false);
}
