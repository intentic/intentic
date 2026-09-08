// True when the browser, not the app, should own this click (Ctrl/Cmd/Shift/Alt opens a tab/window/download);
// app-side navigation must stand down then. Middle-click needs no check: it fires `auxclick`, never `click`.
export const browserOwnsClick = (event: MouseEvent): boolean => event.ctrlKey || event.metaKey || event.shiftKey || event.altKey;

// `{href, onClick}` for an anchor that can't use <RouterLink> (an extension holding a path and host functions).
// Keeps hover/copy/Ctrl-click native; a plain click is redirected to in-app navigation instead of a full reload.
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
