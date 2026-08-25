/* A TEXTAREA THAT IS AS TALL AS WHAT IS IN IT, measured rather than guessed.
 *
 * Four composers had each written this out (the chat composer, the suggested-session box, a chat message's
 * edit box, the commit box) and the copies had already drifted into three different answers to the same two
 * problems, which is why it is one function:
 *
 * `auto` FIRST. A height already set is a floor `scrollHeight` can never report under, so without the reset
 * the box grows for a long message and stays tall after the message gets shorter.
 *
 * A FIELD THAT IS NOT LAID OUT MEASURES NOTHING, and writing that back pins the box shut with no later
 * measurement to undo it: a composer in a closed tab, an overlay before it opens, a row rendered a tick before
 * it is attached. One line of text is the floor, so anything under it is treated as "not measurable yet" and
 * the one-row default stands until a real height exists. (`line-height: normal` parses as NaN and NaN fails
 * every comparison, so the floor yields for a box that never states one: zero is checked outright, because
 * that is the measurement that would pin the box.)
 *
 * THE BORDER IS THE CALLER'S, NOT THE CALLER'S PROBLEM. `scrollHeight` counts padding and never the border, so
 * under `border-box` sizing a height set straight from it is two pixels short of its own text, enough to put a
 * scrollbar on a single-line message. The commit box carried that as a hand-written constant; here it is read
 * off the element, so a box that grows a border does not need to be told again.
 *
 * NOT ProseField, which sizes itself with a CSS grid replica and no JavaScript, and is the technique any NEW
 * box should use: it measures nothing, so it cannot mis-measure the fallback font before the webfont swaps.
 * These four are borderful, capped, keyboard-driven boxes that it is not a drop-in for. */
export const growTextarea = (element: HTMLTextAreaElement | null | undefined, maxHeight?: number): void => {
    if (element === null || element === undefined) {
        return;
    }
    element.style.height = `auto`;
    const style = getComputedStyle(element);
    const oneLine = parseFloat(style.lineHeight) + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    if (element.scrollHeight <= 0 || element.scrollHeight < oneLine) {
        return;
    }
    const border = style.boxSizing === `border-box` ? parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth) : 0;
    const height = element.scrollHeight + border;
    element.style.height = `${maxHeight === undefined ? height : Math.min(height, maxHeight)}px`;
};
