// Both surfaces (useBrowserView, BrowserProfileDialog) render the frame `object-contain`, so it letterboxes inside
// the element's own box; measuring the element instead of the painted rect misses small targets by half the
// letterbox. Clamped at both ends, so a click in the letterbox lands on the nearest page edge.
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

// Places a rect the page reported (a <select>'s bounds, readSelect in screencast.ts) onto the picture as painted,
// sharing viewportCoords' letterbox math so a menu can't drift from the control it opened on. Offsets are within
// the element, for absolute positioning in that same box.
export const pictureRect = (
    element: HTMLElement,
    viewWidth: number,
    viewHeight: number,
    rect: { x: number; y: number; width: number; height: number },
): { left: number; top: number; width: number; height: number } => {
    const box = element.getBoundingClientRect();
    const scale = Math.min(box.width / viewWidth, box.height / viewHeight);
    if (scale <= 0) {
        return { left: 0, top: 0, width: 0, height: 0 };
    }
    return {
        left: (box.width - viewWidth * scale) / 2 + rect.x * scale,
        top: (box.height - viewHeight * scale) / 2 + rect.y * scale,
        width: rect.width * scale,
        height: rect.height * scale,
    };
};
