import { onMounted, onUnmounted, type Ref, watch } from "vue";

/* "Follow the newest content unless the user has scrolled up to read" — the transcript's half of the fact that
 * a chat is read from its bottom edge.
 *
 * The rule lives here, keyed on the only two things it actually depends on: what the user did with the
 * scrollbar, and how the geometry moved underneath them. It used to be a flag on the panel that every surface
 * swapping the transcript had to remember to raise, which the surfaces that don't know the panel exists — the
 * agents board opening a session, a deep link into /agents/:id, the review panel handing a conflict back —
 * could not raise. Those opened a conversation into whatever scroll offset the previous one had left behind,
 * with auto-follow off for the rest of that tab's life. There is no flag to forget now: the panel re-pins on
 * the state change that means "a different transcript is on screen", and everything that reaches that state
 * gets the same result.
 *
 * A scroll event says the view MOVED, not who moved it, and reading one as "the user left" is what made the
 * old flag stick to false. Two things scroll this element with nobody asking: the pin's own write, which
 * arrives back here as an event a frame later, and the browser clamping scrollTop when content shrinks under
 * it. Both of those END at the bottom, so the bottom is tested first and always re-pins; only a move that both
 * went upward and landed away from the bottom is the user leaving to read. Growth on its own can never unpin,
 * because appending to a transcript doesn't move scrollTop at all.
 *
 * The geometry half of that is a ResizeObserver, and a ResizeObserver belongs to a WINDOW: it delivers its
 * callbacks in the rendering steps of the document that CREATED it, whatever document the elements it watches
 * happen to live in. The chat panel is teleported into a real pop-out window (usePopout) with its JS left
 * behind in the opener, so an observer made here — in the opener — reports the popped-out transcript's growth
 * only while the OPENER window is itself painting. A browser stops giving rendering opportunities to a window
 * that is minimized, occluded or in a background tab, which is the normal state of the app window while the
 * user works in the chat window in front of it: the follow simply stopped, and a message sent from the pop-out
 * landed below the fold with nothing to bring it up — the one thing the pin exists to prevent. So the observer
 * is built by the window the transcript is IN, and rebuilt when the panel moves between them, which puts it on
 * the rendering loop of the window the user is looking at (terminalSession.observeHost does this for the same
 * reason). Scroll listeners need none of it: an event fires on the element wherever it lives. */

// How close to the bottom still counts as parked there — about a line of prose, so the follow survives a
// stray wheel notch or a sub-pixel rounding of the scroll offset.
const THRESHOLD = 80;

export const useStickToBottom = (
    scroller: Ref<HTMLElement | undefined>,
    content: Ref<HTMLElement | undefined>,
    // Any value that CHANGES when these elements are teleported to another document — the panel's popped-out
    // flag. Not the document itself: adoption rewrites `ownerDocument` in place, with nothing reactive about it
    // to watch, so the move is announced by whoever performs it.
    host: Ref<unknown>,
): { pin: () => void } => {
    // Closure state rather than refs: nothing renders either of these, and every read happens inside a DOM
    // callback where a reactive read would only cost a dependency nobody collects.
    let pinned = true;
    let lastTop = 0;
    let observer: ResizeObserver | undefined;
    // The element the scroll listener was hung on, so it comes off the same one — a template ref is already
    // cleared by the time the unmount hook runs.
    let listening: HTMLElement | undefined;

    const pin = (): void => {
        pinned = true;
        const element = scroller.value;
        if (element === undefined) {
            return;
        }
        element.scrollTop = element.scrollHeight;
        // Read the write back: the browser clamps it to the real maximum, and that clamped value is what the
        // scroll event this fires next frame will be measured against.
        lastTop = element.scrollTop;
    };

    const onScroll = (): void => {
        const element = scroller.value;
        if (element === undefined) {
            return;
        }
        const top = element.scrollTop;
        const up = top < lastTop;
        lastTop = top;
        if (element.scrollHeight - top - element.clientHeight <= THRESHOLD) {
            pinned = true;
            return;
        }
        if (up) {
            pinned = false;
        }
    };

    /* Two boxes, because the bottom is lost in two unrelated ways. The transcript GROWS — a streamed token, an
     * image finishing load, a tool card opening, prose reflowing at a new panel width — which resizes the
     * content wrapper. Measuring that is O(1) and also catches growth that never appears in the message data at
     * all, which is why this replaced a deep watch that re-walked every message per streamed frame. And the room
     * the transcript is shown in SHRINKS — the panel resized, the floating composer taking another line, the
     * mobile keyboard opening — which lands on the scroller's CONTENT box (its client box minus the padding the
     * composer reserves) and leaves its border box untouched. Neither implies the other, so both are observed.
     *
     * Re-runnable, and the pop-out is why (see above). A fresh observer delivers a first observation of every
     * target it takes on, so a followed transcript re-pins into the window it has just been moved to — where
     * the room it is read in is a window's worth rather than a column's. */
    const observe = (): void => {
        observer?.disconnect();
        observer = undefined;
        const element = scroller.value;
        const wrapper = content.value;
        if (element === undefined || wrapper === undefined) {
            return;
        }
        const view = element.ownerDocument.defaultView ?? window;
        observer = new view.ResizeObserver(() => {
            if (pinned) {
                pin();
            }
        });
        observer.observe(wrapper);
        observer.observe(element, { box: `content-box` });
    };

    onMounted(() => {
        const element = scroller.value;
        if (element === undefined) {
            return;
        }
        lastTop = element.scrollTop;
        listening = element;
        element.addEventListener(`scroll`, onScroll, { passive: true });
        observe();
    });

    // Post-flush: the teleport moves the panel's DOM in the same flush that flips this, so the rebuild reads
    // the document the elements have landed in rather than the one they are leaving.
    watch(host, observe, { flush: `post` });

    onUnmounted(() => {
        observer?.disconnect();
        observer = undefined;
        listening?.removeEventListener(`scroll`, onScroll);
        listening = undefined;
    });

    return { pin };
};
