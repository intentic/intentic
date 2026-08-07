/* WHERE A CLICK LANDS IN THE REMOTE PAGE — the rule both screencast surfaces follow: the agent's browser view
 * (useBrowserView) and a platform's own profile window (BrowserProfileDialog). One module because it is one geometry problem, and
 * a copy of it in each file is a copy that drifts — they had already drifted into the same bug independently.
 *
 * THE ELEMENT'S RECT IS NOT WHERE THE PICTURE IS. Both surfaces render the frame `object-contain` in a box that
 * is almost never the remote viewport's shape, so it paints letterboxed WITHIN that box. Measuring the element
 * therefore puts every click off by half the letterbox — growing with the aspect mismatch, and quietly missing
 * exactly the small targets (checkboxes, close buttons) a person is trying to hit when they take the wheel.
 * object-contain scales to fit and centres, which is two lines to reproduce exactly, so the painted rect is
 * derived rather than measured.
 *
 * Clamped at both ends: a click that lands in the letterbox itself belongs to the nearest edge of the page, not
 * to a coordinate outside it. */
export const viewportCoords = (event: MouseEvent, element: HTMLElement, viewWidth: number, viewHeight: number): { x: number; y: number } => {
    const rect = element.getBoundingClientRect();
    const scale = Math.min(rect.width / viewWidth, rect.height / viewHeight);
    if (scale <= 0) {
        return { x: 0, y: 0 };
    }
    const clamp = (value: number, max: number): number => Math.min(max, Math.max(0, Math.round(value / scale)));
    return {
        x: clamp(event.clientX - rect.left - (rect.width - viewWidth * scale) / 2, viewWidth),
        y: clamp(event.clientY - rect.top - (rect.height - viewHeight * scale) / 2, viewHeight),
    };
};
