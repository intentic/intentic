/* WHOSE CLICK IS IT: the app's, or the browser's.
 *
 * Every row, tile and menu item in this app that goes somewhere is a real anchor, so the browser already knows
 * how to open it in a background tab (Ctrl/⌘), in a window (Shift) or as a download (Alt). What it does not
 * know is that the element ALSO carries app work: a router push, a popover to dismiss, a selection to move:
 * and running that alongside is how a Ctrl-click ends up opening the tab AND navigating the tab you were
 * reading, which is the one outcome nobody asked for.
 *
 * So the rule is one line, and it is here rather than re-derived at each call site because it had already been
 * written three different ways: hand it to the browser, and stand down.
 *
 * MIDDLE-CLICK IS NOT IN IT. A middle press fires `auxclick`, never `click`, so an anchor opens its own tab
 * without any handler hearing about it: the app's work simply never runs, which is already the right answer. */
export const browserOwnsClick = (event: MouseEvent): boolean => event.ctrlKey || event.metaKey || event.shiftKey || event.altKey;

/* The rule above, as the two attributes an anchor needs: for the surfaces that cannot reach the app's router
 * and so cannot use a <RouterLink>: an extension view holds an app PATH and two functions from its host, and
 * nothing else.
 *
 *     <Button as="a" v-bind="appLink(api.href(path), () => api.navigate(path))">Open the session log</Button>
 *
 * The anchor carries the real address, so hovering, copying and Ctrl/⌘-click all behave; the plain click is
 * turned back into in-app navigation, because a full page load of a single-page app is a second of white for
 * a move that costs nothing. */
export const appLink = (href: string, navigate: () => void): { href: string; onClick: (event: MouseEvent) => void } => ({
    href,
    onClick: (event: MouseEvent): void => {
        if (browserOwnsClick(event)) {
            return; // the browser is opening a tab of its own; this one stays put
        }
        event.preventDefault();
        navigate();
    },
});
