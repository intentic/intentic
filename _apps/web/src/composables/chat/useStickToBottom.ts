import { onMounted, onUnmounted, type Ref } from "vue";

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
 * because appending to a transcript doesn't move scrollTop at all. */

// How close to the bottom still counts as parked there — about a line of prose, so the follow survives a
// stray wheel notch or a sub-pixel rounding of the scroll offset.
const THRESHOLD = 80;

export const useStickToBottom = (scroller: Ref<HTMLElement | undefined>, content: Ref<HTMLElement | undefined>): { pin: () => void } => {
    // Closure state rather than refs: nothing renders either of these, and every read happens inside a DOM
    // callback where a reactive read would only cost a dependency nobody collects.
    let pinned = true;
    let lastTop = 0;

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

    onMounted(() => {
        const element = scroller.value;
        if (element === undefined || content.value === undefined) {
            return;
        }
        lastTop = element.scrollTop;
        element.addEventListener(`scroll`, onScroll, { passive: true });
        /* Two boxes, because the bottom is lost in two unrelated ways. The transcript GROWS — a streamed token,
         * an image finishing load, a tool card opening, prose reflowing at a new panel width — which resizes
         * the content wrapper. Measuring that is O(1) and also catches growth that never appears in the message
         * data at all, which is why this replaced a deep watch that re-walked every message per streamed frame.
         * And the room the transcript is shown in SHRINKS — the panel resized, the floating composer taking
         * another line, the mobile keyboard opening — which lands on the scroller's CONTENT box (its client box
         * minus the padding the composer reserves) and leaves its border box untouched. Neither implies the
         * other, so both are observed. */
        const observer = new ResizeObserver(() => {
            if (pinned) {
                pin();
            }
        });
        observer.observe(content.value);
        observer.observe(element, { box: `content-box` });
        onUnmounted(() => {
            observer.disconnect();
            element.removeEventListener(`scroll`, onScroll);
        });
    });

    return { pin };
};
