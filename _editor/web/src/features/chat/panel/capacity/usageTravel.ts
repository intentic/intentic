import { ARRIVE, canAnimate, FOLD_EASE, lessMotion, springTiming } from "@intentic/ui/motion";
import { nextTick, onBeforeUnmount, onMounted, type Ref, watch } from "vue";

// USAGE LEFT TRAVELS WHEN IT CHANGES HOME. It stands in one of two places (features/agents/fleet/Agents.vue): the board's
// corner under Finished, or the chat's side rail once the chat is wide enough for one. The copy leaving and the copy
// arriving show the same figures, so the move is drawn as one thing going from where it stood to where it now stands,
// never as a card vanishing in one place and a column appearing in another. A picture of each flies the path together on
// the arriving spring (ARRIVE): the one leaving fades out early, the one arriving fades in, and the real copy, held
// invisible under its picture, takes over in the frame the picture lands. Pictures, because each copy lives inside a
// column that clips (the board's scroller, the chat's panel), and a copy moved out of its own would be cut off at the seam
// between them. The copy arriving skips its rows' opening reveal: nothing in it is new.
//
// Whether a leaving and an arrival are one move is settled once the render that drew them is done (Vue's next tick,
// still before that frame paints), so it does not matter which home renders first. A leaving with no arrival (the board
// closed, the chat folded into its strip) and an arrival with no leaving (a first sight) play nothing here.

interface Leaving {
    readonly rect: DOMRect;
    readonly picture: HTMLElement;
}

// Shares of the travel's length. The leaving copy's picture is gone within its first quarter; the arriving one starts a
// beat later and is whole before half way, so the two are seen together only briefly, near where the reader was looking,
// and never as two legible columns drawn over each other.
const LEAVE_SHARE = 0.25;
const ARRIVE_DELAY = 0.08;
const ARRIVE_SHARE = 0.4;
// How far the leaving picture grows or shrinks toward the size of the copy arriving: a hint of the change, while it fades.
const RESIZE_REACH = 0.2;
// The rail has no surface of its own; its picture flies as a card, on the ground it stood on, and lands back on it.
const RADIUS = `1rem`;

let leaving: Leaving | undefined;
let arriving: HTMLElement | undefined;
let settling = false;
// The travel in flight: what it lands on, its arriving picture, and what lands it at once.
let flight: { readonly to: HTMLElement; readonly picture: HTMLElement; readonly land: () => void } | undefined;

const onScreen = (rect: DOMRect): boolean =>
    rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < globalThis.innerHeight && rect.left < globalThis.innerWidth;

const transparent = (color: string): boolean => color === `` || color === `transparent` || /(?:,\s*0|\/\s*0%?)\s*\)$/.test(color);

// The fill a copy stands on: its own, or the first one behind it.
const groundOf = (el: HTMLElement): string => {
    for (let at: HTMLElement | null = el; at !== null; at = at.parentElement) {
        const fill = getComputedStyle(at).backgroundColor;
        if (!transparent(fill)) {
            return fill;
        }
    }
    return ``;
};

// A still picture of a copy where it stands, fixed over the page so no column clips it. Still: a transition or an
// animation inside would start over in the copy, as though its figures were new.
const pictureOf = (el: HTMLElement, rect: DOMRect): HTMLElement => {
    // SAFETY: a deep clone of an element is an element of the same kind.
    const picture = el.cloneNode(true) as HTMLElement;
    picture.setAttribute(`aria-hidden`, `true`);
    picture.inert = true;
    for (const part of [picture, ...picture.querySelectorAll<HTMLElement>(`*`)]) {
        part.style.transition = `none`;
        part.style.animation = `none`;
    }
    Object.assign(picture.style, {
        position: `fixed`,
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        margin: `0`,
        zIndex: `40`,
        overflow: `clip`,
        pointerEvents: `none`,
        transformOrigin: `top left`,
    });
    if (transparent(getComputedStyle(el).backgroundColor)) {
        Object.assign(picture.style, { background: groundOf(el), borderRadius: RADIUS });
    }
    return picture;
};

// Brings what the copy arriving was starting (its rows' reveal, a bar's first fill) to where it ends, so it is whole when
// it takes over from its picture. An endless loop (a spinner) is left running.
const finishOpenings = (el: HTMLElement): void => {
    for (const run of el.getAnimations?.({ subtree: true }) ?? []) {
        if (run.effect?.getComputedTiming().iterations !== Number.POSITIVE_INFINITY) {
            run.finish();
        }
    }
};

// Where an element comes to rest once whatever carries it has finished moving (Finished's lane sliding to where it was
// pinned, cornerFit.ts): each ancestor's own animation is read at its end, then put back where it was. Without it, a
// picture aimed at a lane mid-slide landed short and the copy it handed over to jumped.
const restingRect = (el: HTMLElement): DOMRect => {
    const moving: [Animation, CSSNumberish | null][] = [];
    for (let at = el.parentElement; at !== null; at = at.parentElement) {
        for (const run of at.getAnimations?.() ?? []) {
            // In milliseconds on the document's clock; a scroll-driven run is not one to settle.
            const end = Number(run.effect?.getComputedTiming().endTime);
            if (run.timeline === document.timeline && run.playState === `running` && Number.isFinite(end)) {
                moving.push([run, run.currentTime]);
                run.currentTime = end;
            }
        }
    }
    const rect = el.getBoundingClientRect();
    for (const [run, at] of moving) {
        run.currentTime = at;
    }
    return rect;
};

const travel = (from: Leaving, to: HTMLElement): void => {
    const there = restingRect(to);
    const dx = from.rect.left - there.left;
    const dy = from.rect.top - there.top;
    const { duration, easing } = springTiming(Math.hypot(dx, dy), 0, ARRIVE);
    if (duration === 0 || !onScreen(there)) {
        from.picture.remove();
        return;
    }
    finishOpenings(to);
    const picture = pictureOf(to, there);
    document.body.append(picture);
    const reach = 1 + Math.max(-RESIZE_REACH, Math.min(RESIZE_REACH, there.width / from.rect.width - 1));
    const runs = [
        // The real copy waits under its picture until the picture lands.
        to.animate([{ opacity: 0 }, { opacity: 0 }], { duration, fill: `forwards` }),
        picture.animate([{ translate: `${dx}px ${dy}px` }, { translate: `0 0` }], { duration, easing }),
        picture.animate([{ opacity: 0 }, { opacity: 1 }], {
            duration: Math.round(duration * ARRIVE_SHARE),
            delay: Math.round(duration * ARRIVE_DELAY),
            easing: FOLD_EASE,
            fill: `backwards`,
        }),
        from.picture.animate([{ translate: `0 0`, scale: `1` }, { translate: `${-dx}px ${-dy}px`, scale: `${reach}` }], { duration, easing, fill: `forwards` }),
        from.picture.animate([{ opacity: 1 }, { opacity: 0 }], { duration: Math.round(duration * LEAVE_SHARE), easing: FOLD_EASE, fill: `forwards` }),
    ];
    const land = (): void => {
        if (flight?.land !== land) {
            return;
        }
        flight = undefined;
        for (const run of runs) {
            run.cancel();
        }
        picture.remove();
        from.picture.remove();
    };
    flight = { to, picture, land };
    void runs[1]?.finished.then(land, land);
};

const settle = (): void => {
    settling = false;
    const from = leaving;
    const to = arriving;
    leaving = undefined;
    arriving = undefined;
    if (from === undefined) {
        return;
    }
    // A travel still in flight is overtaken: what it was landing on has just left again.
    flight?.land();
    if (to === undefined || !to.isConnected || !canAnimate(to)) {
        from.picture.remove();
        return;
    }
    travel(from, to);
};

const settleAfterRender = (): void => {
    if (!settling) {
        settling = true;
        void nextTick(settle);
    }
};

/** Usage left's own copy (ChatCapacityRail.vue, by its root): arriving and leaving are how its travels are told. */
export const useUsageTravel = (root: Readonly<Ref<HTMLElement | undefined>>): void => {
    onMounted(() => {
        if (root.value !== undefined) {
            arriving = root.value;
            settleAfterRender();
        }
    });
    onBeforeUnmount(() => {
        const el = root.value;
        if (el === undefined || !canAnimate(el) || lessMotion()) {
            return;
        }
        // Leaving mid-travel, it leaves from where its picture is on screen now, not from where it was landing.
        const rect = flight?.to === el ? flight.picture.getBoundingClientRect() : el.getBoundingClientRect();
        if (!onScreen(rect)) {
            return;
        }
        leaving?.picture.remove();
        const picture = pictureOf(el, rect);
        document.body.append(picture);
        leaving = { rect, picture };
        settleAfterRender();
    });
};

// THE CHAT'S COLUMNS MAKE ROOM. The rail arriving narrows each pane by its width and the reading column re-centres in what
// is left; leaving, the column widens back. Drawn at once at its new width, the column then glides from where its text
// started to where it starts now, on the same spring and in the same frame as Usage left's travel, so the room opens as
// the rail arrives in it. By the left edge, where every line starts and the eye holds on: a column whose width changed a
// lot (a drag that ran far past where the rail fits) never slides out past the panel's own edge. Measured off each pane's
// footer, which stands in the column like the transcript above it; the whole of the pane's content moves.
export const useRailRoom = (panel: Readonly<Ref<HTMLElement | undefined>>, rail: () => boolean): void => {
    const footers = (): HTMLElement[] => [...(panel.value?.querySelectorAll<HTMLElement>(`.chat-pane [data-lane-floor]`) ?? [])];
    let before: Map<HTMLElement, number> | undefined;
    watch(
        rail,
        () => {
            before = lessMotion() ? undefined : new Map(footers().map((footer) => [footer, footer.getBoundingClientRect().left]));
        },
        { flush: `pre` },
    );
    watch(
        rail,
        () => {
            const was = before;
            before = undefined;
            if (was === undefined) {
                return;
            }
            for (const footer of footers()) {
                const from = was.get(footer);
                const content = footer.parentElement;
                const dx = from === undefined ? 0 : from - footer.getBoundingClientRect().left;
                if (Math.abs(dx) >= 0.5 && canAnimate(content)) {
                    content.animate([{ translate: `${dx}px 0` }, { translate: `0 0` }], springTiming(Math.abs(dx), 0, ARRIVE));
                }
            }
        },
        { flush: `post` },
    );
};
