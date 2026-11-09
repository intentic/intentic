import { canAnimate, FOLD_EASE, lessMotion } from "@intentic/ui/motion";
import { nextTick, onScopeDispose, type Ref, watch } from "vue";
import { type Arrival, type Box, type Flight, planFlights, type RailArrangement, type RailMark, type Travel } from "./railFlights";

// THE RAIL SHOWS WHAT IT DOES (2026-11-09). The shell has one rail in two states (models/home/masterRail.ts): folded
// onto one sandbox, its sections as the tiles, or unrolled onto every sandbox, the sections put away in the bookmark at
// its foot. Swapped in one frame, that read as two different screens. So the change is played: unrolling, each sandbox
// flies out of the switcher or the cluster under it to its own tile while every section tile is drawn down into the
// bookmark; folding, the reverse. What moved where is the whole explanation, and nobody has to be told.
//
// The rail's parts say what they are, and this module knows none of them by name:
//   data-rail-key="sandbox:<id>"   the same thing in both states: it flies from where it was to where it is
//   data-rail-into="sandboxes"     the group it belongs to, for when the other state has no place of its own for it
//   data-rail-holds="sandboxes"    what stands for a whole group folded away (the cluster, the bookmark): members with
//                                  no place of their own fly into it, and out of it
// Which flies where is railFlights.ts's, pure; this draws it.
//
// A flight is a copy of the part in a layer over the rail, moved by `transform` and `opacity` alone, so the compositor
// carries it whatever the page under it is doing; the part itself is already where it belongs, hidden until its copy
// lands. Copies rather than the parts themselves, since a part leaving is no longer in the page to move, and one arriving
// sits in a scrolling run that would clip it on the way. Two reads of the layout per change (before and after), no
// script per frame, and nothing at all with motion off (@intentic/ui/motion `lessMotion`).

const KEY = `data-rail-key`;
const INTO = `data-rail-into`;
const HOLDS = `data-rail-holds`;

const FLIGHT_MS = 320;
const APPEAR_MS = 200;
const SWELL_MS = 260;
const STEP_MS = 18;
// The stagger stops growing here: a rail of thirty tiles still settles in under half a second.
const MAX_STEPS = 7;
const delayOf = (step: number): number => Math.min(step, MAX_STEPS) * STEP_MS;

// The rail as it was read: where its parts stand, the parts themselves, and a copy of each when asked for, taken while
// it is still in the page (the next render may remove it).
interface Reading {
    readonly stands: RailArrangement;
    readonly nodes: ReadonlyMap<string, HTMLElement>;
    readonly holders: ReadonlyMap<string, HTMLElement>;
    readonly copies: ReadonlyMap<string, HTMLElement>;
    // The same of what holds each group, by the group.
    readonly holderCopies: ReadonlyMap<string, HTMLElement>;
}

const boxOf = (rect: DOMRect): Box => ({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });

// Drawn, and not scrolled out of the run it sits in: a tile below the fold has nowhere on screen to fly from or to.
const onScreen = (el: HTMLElement, rect: DOMRect): boolean => {
    if (rect.width === 0 || rect.height === 0) {
        return false;
    }
    const run = el.closest<HTMLElement>(`.icon-rail-nav`)?.getBoundingClientRect();
    return run === undefined || (rect.bottom > run.top && rect.top < run.bottom);
};

// A copy that draws as its source did wherever it is put: what it took from its place in the rail (its type size, its
// ink) is written onto it, and what would make it a second one of anything (an id, a mark of its own) is taken off.
const copyOf = (source: HTMLElement): HTMLElement => {
    // SAFETY: cloning an HTMLElement yields an HTMLElement.
    const copy = source.cloneNode(true) as HTMLElement;
    const style = getComputedStyle(source);
    copy.style.fontSize = style.fontSize;
    copy.style.color = style.color;
    for (const node of [copy, ...copy.querySelectorAll<HTMLElement>(`[id], [${KEY}], [${HOLDS}]`)]) {
        node.removeAttribute(`id`);
        node.removeAttribute(KEY);
        node.removeAttribute(INTO);
        node.removeAttribute(HOLDS);
    }
    return copy;
};

const readRail = (root: HTMLElement, copies: boolean): Reading => {
    const marks: RailMark[] = [];
    const nodes = new Map<string, HTMLElement>();
    const kept = new Map<string, HTMLElement>();
    for (const el of root.querySelectorAll<HTMLElement>(`[${KEY}]`)) {
        const key = el.getAttribute(KEY) ?? ``;
        const rect = el.getBoundingClientRect();
        if (key === `` || nodes.has(key) || !onScreen(el, rect)) {
            continue;
        }
        marks.push({ key, into: el.getAttribute(INTO) ?? undefined, box: boxOf(rect) });
        nodes.set(key, el);
        if (copies) {
            kept.set(key, copyOf(el));
        }
    }
    const boxes: Record<string, Box> = {};
    const holders = new Map<string, HTMLElement>();
    const keptHolders = new Map<string, HTMLElement>();
    for (const el of root.querySelectorAll<HTMLElement>(`[${HOLDS}]`)) {
        const group = el.getAttribute(HOLDS) ?? ``;
        const rect = el.getBoundingClientRect();
        if (group !== `` && rect.width > 0 && rect.height > 0) {
            boxes[group] = boxOf(rect);
            holders.set(group, el);
            if (copies) {
                keptHolders.set(group, copyOf(el));
            }
        }
    }
    return { stands: { marks, holders: boxes }, nodes, holders, copies: kept, holderCopies: keptHolders };
};

// The transform that draws a copy standing at `own` as if it stood at `as`.
const drawnAs = (own: Box, as: Box): string =>
    `translate3d(${as.left - own.left}px, ${as.top - own.top}px, 0) scale(${as.width / own.width}, ${as.height / own.height})`;
const AT_REST = `translate3d(0, 0, 0) scale(1, 1)`;

// Where the copies fly: a layer over the rail and inside it, so a copy wears the rail's own measures and a skin's own
// paint. Fixed to the window; its place is read back, since a skin that filters the rail makes the rail what "fixed" is
// fixed to.
interface Stage {
    readonly before: Reading;
    readonly after: Reading;
    readonly running: Animation[];
    /** Puts a copy in the layer, standing at `box`. */
    readonly place: (copy: HTMLElement, box: Box) => HTMLElement;
    readonly clear: () => void;
}

const stageOver = (root: HTMLElement, before: Reading, after: Reading): Stage => {
    const layer = document.createElement(`div`);
    layer.setAttribute(`aria-hidden`, `true`);
    layer.inert = true;
    layer.dataset[`railMorph`] = ``;
    layer.style.cssText = `position:fixed;inset:0;z-index:60;pointer-events:none`;
    root.append(layer);
    const origin = layer.getBoundingClientRect();
    const place = (copy: HTMLElement, box: Box): HTMLElement => {
        copy.style.cssText += `;position:absolute;left:${box.left - origin.left}px;top:${box.top - origin.top}px;width:${box.width}px;height:${box.height}px;margin:0;transform-origin:0 0;will-change:transform,opacity`;
        layer.append(copy);
        return copy;
    };
    return { before, after, running: [], place, clear: () => layer.remove() };
};

const timingOf = (flight: Flight): KeyframeAnimationOptions => ({ duration: FLIGHT_MS, delay: delayOf(flight.step), easing: FOLD_EASE, fill: `both` });

// New, with nowhere to come from: the part itself, in place, once what flies is on its way. What holds a group is there
// from the first frame instead, since it is where the group is seen to go.
const appear = (stage: Stage, flight: Arrival): void => {
    const part = stage.after.nodes.get(flight.key);
    if (part !== undefined) {
        const delay = part.hasAttribute(HOLDS) ? 0 : delayOf(flight.step) + FLIGHT_MS / 3;
        stage.running.push(
            part.animate(
                [
                    { opacity: 0, transform: `scale(0.8)` },
                    { opacity: 1, transform: `scale(1)` },
                ],
                { duration: APPEAR_MS, delay, easing: FOLD_EASE, fill: `backwards` },
            ),
        );
    }
};

// Gone, into what holds its group now: its copy as it stood, drawn down to a speck there.
const merge = (stage: Stage, flight: Travel): void => {
    const copy = stage.before.copies.get(flight.key);
    if (copy !== undefined) {
        stage.running.push(
            stage.place(copy, flight.from).animate(
                [
                    { transform: AT_REST, opacity: 1 },
                    { opacity: 1, offset: 0.45 },
                    { transform: drawnAs(flight.from, flight.to), opacity: 0 },
                ],
                timingOf(flight),
            ),
        );
    }
};

// Here now: a copy of the part as it is, flown in from where it was (a move) or out of what held it (an emerge), the
// part itself unseen where it belongs until the copy lands on it.
const arrive = (stage: Stage, flight: Travel): void => {
    const part = stage.after.nodes.get(flight.key);
    if (part === undefined) {
        return;
    }
    const timing = timingOf(flight);
    stage.running.push(part.animate([{ opacity: 0 }, { opacity: 0 }], { duration: delayOf(flight.step) + FLIGHT_MS }));
    // A move between two looks (a circle of the cluster, a tile of the rail): the old look rides the same path over the
    // new one and the two change places on the way, so the look changes in flight rather than at either end.
    const old = flight.kind === `move` && Math.abs(flight.from.width - flight.to.width) >= 0.5 ? stage.before.copies.get(flight.key) : undefined;
    const fadesIn = flight.kind === `emerge` || old !== undefined;
    stage.running.push(
        stage.place(copyOf(part), flight.to).animate(
            [
                { transform: drawnAs(flight.to, flight.from), opacity: fadesIn ? 0 : 1 },
                { opacity: 1, offset: 0.5 },
                { transform: AT_REST, opacity: 1 },
            ],
            timing,
        ),
    );
    if (old !== undefined) {
        stage.running.push(
            stage.place(old, flight.from).animate(
                [
                    { transform: AT_REST, opacity: 1 },
                    { opacity: 0, offset: 0.6 },
                    { transform: drawnAs(flight.from, flight.to), opacity: 0 },
                ],
                timing,
            ),
        );
    }
};

// What held a group lets it go: its copy stays where it stood for the first of the flight and fades, so the parts are
// seen to come out of something rather than out of the rail's bare ground.
const release = (stage: Stage, emerges: readonly Travel[]): void => {
    const groups = new Set(emerges.map((flight) => stage.after.stands.marks.find((mark) => mark.key === flight.key)?.into));
    for (const group of groups) {
        const copy = group === undefined ? undefined : stage.before.holderCopies.get(group);
        const box = group === undefined ? undefined : stage.before.stands.holders[group];
        if (copy !== undefined && box !== undefined) {
            stage.running.push(
                stage.place(copy, box).animate([{ opacity: 1, transform: `scale(1)` }, { opacity: 0, transform: `scale(0.8)` }], {
                    duration: FLIGHT_MS / 2,
                    easing: FOLD_EASE,
                    fill: `both`,
                }),
            );
        }
    }
};

// What took a group in answers as the last of it arrives: one small swell, so the eye is left on where they went.
const swell = (stage: Stage, merges: readonly Travel[]): void => {
    const arrivals = new Map<string, number>();
    for (const flight of merges) {
        const group = stage.before.stands.marks.find((mark) => mark.key === flight.key)?.into;
        if (group !== undefined) {
            arrivals.set(group, Math.max(arrivals.get(group) ?? 0, delayOf(flight.step) + FLIGHT_MS));
        }
    }
    for (const [group, at] of arrivals) {
        const frames = [{ transform: `scale(1)` }, { transform: `scale(1.16)`, offset: 0.5 }, { transform: `scale(1)` }];
        const run = stage.after.holders.get(group)?.animate(frames, { duration: SWELL_MS, delay: Math.max(0, at - SWELL_MS / 2), easing: FOLD_EASE });
        if (run !== undefined) {
            stage.running.push(run);
        }
    }
};

// Plays the flights from `before` to the rail as it stands now. Returns what stops them early; nothing when none flew.
const play = (root: HTMLElement, before: Reading): (() => void) | undefined => {
    const after = readRail(root, false);
    const flights = planFlights(before.stands, after.stands);
    if (flights.length === 0) {
        return undefined;
    }
    const stage = stageOver(root, before, after);
    for (const flight of flights) {
        if (flight.kind === `appear`) {
            appear(stage, flight);
        } else if (flight.kind === `merge`) {
            merge(stage, flight);
        } else {
            arrive(stage, flight);
        }
    }
    const travels = flights.filter((flight): flight is Travel => flight.kind !== `appear`);
    swell(
        stage,
        travels.filter((flight) => flight.kind === `merge`),
    );
    release(
        stage,
        travels.filter((flight) => flight.kind === `emerge`),
    );
    let over = false;
    const stop = (): void => {
        if (over) {
            return;
        }
        over = true;
        for (const animation of stage.running) {
            animation.cancel();
        }
        stage.clear();
    };
    // allow(silent-catch): a flight cancelled by the next change rejects `finished`, and `stop` has already cleared it.
    void Promise.all(stage.running.map((animation) => animation.finished)).then(stop, () => undefined);
    return stop;
};

/**
 * Plays the rail's change each time `unrolled` flips while the rail is mounted: the parts are read as they stand before
 * the render that swaps them, and flown once it has. A change made while another is in flight ends that one where it
 * belongs first. Called from the setup of the component that draws the rail.
 */
export const useRailMorph = (rail: () => HTMLElement | null | undefined, unrolled: Readonly<Ref<boolean>>): void => {
    let stop: (() => void) | undefined;
    watch(
        unrolled,
        () => {
            stop?.();
            stop = undefined;
            const root = rail();
            if (lessMotion() || !canAnimate(root) || document.visibilityState !== `visible`) {
                return;
            }
            const before = readRail(root, true);
            void nextTick(() => {
                if (root.isConnected) {
                    stop = play(root, before);
                }
            });
        },
        { flush: `pre` },
    );
    onScopeDispose(() => stop?.());
};
