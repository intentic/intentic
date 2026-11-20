// The screen's device pixels per CSS pixel, followed as it changes: the window dragged to another monitor, the
// browser's zoom, the OS's scaling. castd sizes its screen to the stage × this, so the picture is drawn 1:1 in device
// pixels; a change is a new box to ask for. A media query for exactly the current ratio stops matching the moment it
// changes, which is the one event the platform gives for it.

export interface RatioWindow {
    readonly devicePixelRatio: number;
    readonly matchMedia: (query: string) => Pick<MediaQueryList, `addEventListener` | `removeEventListener`>;
}

/** Calls `changed` with the new ratio whenever it changes; returns the stop. */
export const watchPixelRatio = (changed: (ratio: number) => void, view: RatioWindow = window): (() => void) => {
    let stop: (() => void) | undefined;
    const listen = (): void => {
        const query = view.matchMedia(`(resolution: ${view.devicePixelRatio}dppx)`);
        const onChange = (): void => {
            stop?.();
            listen();
            changed(view.devicePixelRatio);
        };
        query.addEventListener(`change`, onChange);
        stop = () => query.removeEventListener(`change`, onChange);
    };
    listen();
    return () => {
        stop?.();
        stop = undefined;
    };
};

/** The window an element is in: a popped-out pane's own, whose screen may have another ratio than the editor's. */
export const windowOf = (element: Element | null | undefined): Window => element?.ownerDocument.defaultView ?? window;
