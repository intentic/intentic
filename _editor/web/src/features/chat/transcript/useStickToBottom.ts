import { onMounted, onUnmounted, type Ref } from "vue";

/* "Follow the newest content unless the user has scrolled up to read", the transcript's half of the fact that
 * a chat is read from its bottom edge.
 *
 * The rule lives here, keyed on what the user did with the scrollbar; everything else, the geometry moving
 * underneath them, the panel saying the transcript changed, arrives through `follow` and re-pins whoever has
 * not left. It used to be a flag on the panel that every surface
 * swapping the transcript had to remember to raise, which the surfaces that don't know the panel exists, the
 * agents board opening a session, a deep link into /agents/:id, the review panel handing a conflict back,
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
 * callbacks in the rendering steps of the document that CREATED it. That used to be a real problem here, and it
 * is worth knowing why it no longer is: a floating chat used to be DOM teleported into a second window with its
 * JS left behind in the opener, so this observer ran on the OPENER's frames, and a browser gives none to a
 * window that is minimized, occluded or backgrounded, which is the normal state of the app window while the
 * user works in the chat window in front of it. The follow simply stopped, and a message sent from out there
 * landed below the fold with nothing to bring it up. A floating panel is rendered by its own window now
 * (composables/floating.ts), so the transcript, this observer and the frames they run on are always the same
 * window's, and there is nothing left to re-home. */

// How close to the bottom still counts as parked there, about a line of prose, so the follow survives a
// stray wheel notch or a sub-pixel rounding of the scroll offset.
const THRESHOLD = 80;

export const useStickToBottom = (
    scroller: Ref<HTMLElement | undefined>,
    content: Ref<HTMLElement | undefined>,
): { pin: () => void; follow: () => void } => {
    // Closure state rather than refs: nothing renders either of these, and every read happens inside a DOM
    // callback where a reactive read would only cost a dependency nobody collects.
    let pinned = true;
    let lastTop = 0;
    let observer: ResizeObserver | undefined;
    // The element the scroll listener was hung on, so it comes off the same one, a template ref is already
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

    /* "Whatever just changed, stay where the transcript is being read from", the pin, conditional on the
     * reader not having left. The geometry observers below run through this, and so does the panel on the
     * transcript changing (ChatPanel's follow watch): an observation is a MEASUREMENT of two boxes, and it is
     * only ever as good as the frame it was taken in, a notification the browser coalesces away or defers past
     * the growth that caused it (a resize-observer loop hitting its depth limit does exactly this) leaves the
     * newest content below the fold with nothing to bring it up. Being told "the transcript changed" needs no
     * frame to be true in, so the two together cover what neither does alone. */
    const follow = (): void => {
        if (pinned) {
            pin();
        }
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

    /* Two boxes, because the bottom is lost in two unrelated ways. The transcript GROWS, a streamed token, an
     * image finishing load, a tool card opening, prose reflowing at a new panel width, which resizes the
     * content wrapper. Measuring that is O(1) and also catches growth that never appears in the message data at
     * all, which is why this replaced a deep watch that re-walked every message per streamed frame. And the room
     * the transcript is shown in SHRINKS, the panel resized, the floating composer taking another line, the
     * mobile keyboard opening, which lands on the scroller's CONTENT box (its client box minus the padding the
     * composer reserves) and leaves its border box untouched. Neither implies the other, so both are observed.
     *
     * Neither implies the other, so both are observed. */
    const observe = (): void => {
        observer?.disconnect();
        observer = undefined;
        const element = scroller.value;
        const wrapper = content.value;
        if (element === undefined || wrapper === undefined) {
            return;
        }
        observer = new ResizeObserver(follow);
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

    onUnmounted(() => {
        observer?.disconnect();
        observer = undefined;
        listening?.removeEventListener(`scroll`, onScroll);
        listening = undefined;
    });

    return { pin, follow };
};
