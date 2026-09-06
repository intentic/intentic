/* WHERE THE READER IS — answered once, for every surface that draws the navigation.
 *
 * The bar and the phone overlay render the same `navEntries` and had two different answers to "is this the
 * page we are on": the bar matched a prefix for a menu and an exact path for a row, and the overlay did not
 * ask at all, so a phone got no current mark anywhere. Two implementations of one question is how the desktop
 * panel and the rail came to disagree in the first place, so there is one here and both files read it.
 *
 * The trailing slash is "always" in a build and "ignore" in dev, so it is never part of a comparison.
 */
import type { MenuItem, NavEntry } from "@intentic/site-content/nav";

const bare = (path: string): string => path.replace(/\/+$/u, "");

/**
 * A BAR LABEL is current for a whole region of the site: every page under one of its prefixes. That is the
 * claim a trigger should make — "Docs" is where you are on all twenty docs pages — and it is exactly the
 * claim a row inside the menu must not make.
 *
 * A MENU CARRIES SEVERAL PREFIXES because a menu is no longer one folder: Resources gathers /guides, /blog,
 * /compare and /changelog, and Developers gathers /developers, /api and /extensions. A bare link is
 * still one path, because a link that stood for several regions would be a menu.
 */
export function isCurrentSection(entry: NavEntry, path: string): boolean {
    if (entry.type === "link") {
        return path === entry.href || path.startsWith(entry.prefix);
    }
    return entry.prefixes.some((prefix) => path.startsWith(prefix));
}

/**
 * A MENU ROW is current on the page it points at, and on every other page of the shelf it stands for (see
 * `covers` in `bookDestinations`). A row derived from something other than a book carries no shelf, so it
 * falls back to the one page — which for a feature page or a single destination is the whole truth.
 */
export function isCurrentRow(item: MenuItem, path: string): boolean {
    const here = bare(path);
    return bare(item.href) === here || (item.covers?.some((page) => bare(page) === here) ?? false);
}
