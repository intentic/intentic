// A rendered page fitted to the pane it is read in: docx-preview draws pages at their paper width (an A4 page is
// 794 CSS px), which a half-width pane or a phone cannot show whole, and its centred flex column then clips the
// page's left edge out of reach of any scroll. The wrapper is zoomed down to fit, never up, and never below half,
// past which the page scrolls sideways rather than becoming unreadable.

const GUTTER = 32;
const MIN_ZOOM = 0.5;

/** Zooms the rendered document's wrapper so its widest page fits the host; call after every render and resize. */
export const fitPages = (host: HTMLElement): void => {
    const wrapper = host.querySelector<HTMLElement>(`.docx-wrapper`);
    if (wrapper === null) {
        return;
    }
    wrapper.style.zoom = ``;
    const widest = Math.max(0, ...[...wrapper.querySelectorAll<HTMLElement>(`:scope > section`)].map((page) => page.offsetWidth));
    if (widest === 0) {
        return;
    }
    const zoom = Math.min(1, (host.clientWidth - GUTTER) / widest);
    wrapper.style.zoom = zoom < 1 ? String(Math.max(MIN_ZOOM, zoom)) : ``;
};

/** Keeps `host`'s pages fitted as the pane resizes; returns the stop. */
export const keepFitted = (host: HTMLElement, onFit: () => void = () => {}): (() => void) => {
    const refit = (): void => {
        fitPages(host);
        onFit();
    };
    const observer = new ResizeObserver(refit);
    observer.observe(host);
    return (): void => observer.disconnect();
};
