// WHETHER A PROMPT'S TEXT OVERFLOWS ITS CLAMP, answered for every prompt in one pass. The clamp (.chat-prompt-text)
// depends on wrap width, so it is measured when a bubble resizes rather than guessed from the text; each prompt used to
// hold its own ResizeObserver, and each callback's answer re-rendered its row before the next callback read its own
// bubble, so a chat opening with a hundred prompts laid itself out a hundred times (300ms of a 420-row open at 4× CPU
// throttle). One observer delivers every bubble that resized in one callback; all of them are read, then all answered.

interface Watched {
    // Skips measuring (an expanded prompt always fits, and remeasuring would clear its collapse flag).
    readonly skip: () => boolean;
    readonly answer: (overflowing: boolean) => void;
}

const watched = new Map<Element, Watched>();
let observer: ResizeObserver | undefined;

// Both axes, because the clamp changes axis with the row: six wrapped lines in flow, one nowrap line with an ellipsis
// while the row is stuck (.chat-prompt-pinned in chat.css).
const overflows = (element: Element): boolean => element.scrollHeight > element.clientHeight + 1 || element.scrollWidth > element.clientWidth + 1;

const onResize = (entries: readonly ResizeObserverEntry[]): void => {
    const readings: [Watched, boolean][] = [];
    for (const entry of entries) {
        const bubble = watched.get(entry.target);
        if (bubble !== undefined && !bubble.skip()) {
            readings.push([bubble, overflows(entry.target)]);
        }
    }
    for (const [bubble, overflowing] of readings) {
        bubble.answer(overflowing);
    }
};

/** Watches one prompt bubble until the returned release is called. */
export const watchClamp = (element: HTMLElement, bubble: Watched): (() => void) => {
    observer ??= new ResizeObserver(onResize);
    watched.set(element, bubble);
    observer.observe(element);
    return () => {
        watched.delete(element);
        observer?.unobserve(element);
    };
};
