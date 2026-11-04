// A pointer drag's release also lands as a click on whatever it was pressed on. Capture that one click before the
// pressed element's own handler (a router link, a tile's select) can act on it; a release that fires no click leaves
// nothing behind, since the capture is dropped once the current task ends.
export const swallowClick = (): void => {
    const swallow = (event: MouseEvent): void => {
        event.preventDefault();
        event.stopPropagation();
    };
    window.addEventListener(`click`, swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener(`click`, swallow, { capture: true }), 0);
};
