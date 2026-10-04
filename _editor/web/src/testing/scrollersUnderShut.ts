// The scroll boxes inside a shut `hidden="until-found"` element. There may be none: Chromium keeps one that scrolled as
// a stale scroller and paints the transcript's sticky boxes at an old offset (`.chat-mark-material` in chat.css). The
// shut element may scroll itself. Read off the utility classes, which is all of the CSS jsdom has.
const SCROLLS = new Set([`overflow-auto`, `overflow-y-auto`, `overflow-scroll`, `overflow-y-scroll`]);

export const scrollersUnderShut = (root: ParentNode): Element[] =>
    [...root.querySelectorAll(`[hidden="until-found"] *`)].filter((node) => [...node.classList].some((name) => SCROLLS.has(name)));
