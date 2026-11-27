// Flow.astro's motion. The HTML is the still frame (every wire drawn, the last node lit); this script takes the
// figure down to its first frame only when it is off screen at load, so a reader never sees it un-draw.
//
//   arrive   a third in view: the wires draw (CSS, over `--motion-draw`), then the loop starts
//   loop     one `--motion-cycle`: the first node lit, the pulse along its wire, the next node lit, ... the last
//            node lit, a breath with nothing lit; one lit thing at a time
//   pause    off screen, or while the pointer is on a node (which lights that node and its wires instead)
//   still    under reduced motion (`--motion-loop: paused`) the loop never starts and the HTML's frame stays

import { isInView, loopsRun, tokenMs, watchView } from "./motion";

type Step = { kind: "node"; index: number } | { kind: "wire"; index: number } | { kind: "rest" };

interface Flow {
    figure: HTMLElement;
    nodes: HTMLElement[];
    steps: Step[];
    step: number;
    timer: number | undefined;
    travel: Animation | undefined;
    inView: boolean;
    pointed: boolean;
    drawing: boolean;
}

/** Node, wire, node, wire, ... node, rest: every node lit once and every wire travelled once. */
const stepsFor = (count: number): Step[] => [
    ...Array.from({ length: count }, (_, index): Step[] =>
        index < count - 1 ? [{ kind: "node", index }, { kind: "wire", index }] : [{ kind: "node", index }],
    ).flat(),
    { kind: "rest" },
];

/** How long a step lasts: a cycle split so a wire takes nine tenths of a node's dwell and the breath one dwell. */
const durationOf = (step: Step, count: number): number => {
    const dwell = tokenMs("--motion-cycle") / (count + 0.9 * (count - 1) + 1);
    return step.kind === "wire" ? dwell * 0.9 : dwell;
};

const unlight = (flow: Flow): void => {
    for (const node of flow.nodes) {
        delete node.dataset.lit;
        delete node.dataset.wireLit;
    }
};

const sendPulse = (flow: Flow, index: number, duration: number): void => {
    const wire = flow.nodes[index]?.querySelector<HTMLElement>(".kit-flow-wire");
    const pulse = wire?.querySelector<HTMLElement>(".kit-flow-pulse");
    if (wire === undefined || wire === null || pulse === null || pulse === undefined) {
        return;
    }
    const axis = wire.offsetWidth >= wire.offsetHeight ? "X" : "Y";
    const curve = getComputedStyle(document.documentElement).getPropertyValue("--ease-smooth").trim() || "ease-out";
    flow.travel = pulse.animate(
        [
            { transform: `translate${axis}(-100%)`, opacity: 0 },
            { opacity: 1, offset: 0.12 },
            { opacity: 1, offset: 0.88 },
            { transform: `translate${axis}(0)`, opacity: 0 },
        ],
        { duration, easing: curve },
    );
};

const show = (flow: Flow, step: Step, duration: number): void => {
    unlight(flow);
    if (step.kind === "node") {
        const node = flow.nodes[step.index];
        if (node !== undefined) {
            node.dataset.lit = "";
        }
    } else if (step.kind === "wire") {
        const node = flow.nodes[step.index];
        if (node !== undefined) {
            node.dataset.wireLit = "";
        }
        sendPulse(flow, step.index, duration);
    }
};

const run = (flow: Flow): void => {
    const step = flow.steps[flow.step];
    if (step === undefined) {
        return;
    }
    const duration = durationOf(step, flow.nodes.length);
    show(flow, step, duration);
    flow.timer = window.setTimeout(() => {
        flow.step = (flow.step + 1) % flow.steps.length;
        run(flow);
    }, duration);
};

const pause = (flow: Flow): void => {
    window.clearTimeout(flow.timer);
    flow.timer = undefined;
    flow.travel?.cancel();
    flow.travel = undefined;
};

/** Runs the loop from the step it was paused on, if nothing holds it. */
const resume = (flow: Flow): void => {
    if (flow.timer !== undefined || !flow.inView || flow.pointed || flow.drawing) {
        return;
    }
    run(flow);
};

/** Pointing at a node lights it and its wires, and holds the loop. */
const wirePointer = (flow: Flow, live: boolean): void => {
    flow.nodes.forEach((node, index) => {
        node.addEventListener("pointerenter", (event) => {
            if (event.pointerType === "touch") {
                return;
            }
            flow.pointed = true;
            pause(flow);
            unlight(flow);
            flow.figure.dataset.flow = "pointing";
            node.dataset.lit = "";
            node.dataset.wireLit = "";
            const before = flow.nodes[index - 1];
            if (before !== undefined) {
                before.dataset.wireLit = "";
            }
        });
    });
    flow.figure.addEventListener("pointerleave", () => {
        if (!flow.pointed) {
            return;
        }
        flow.pointed = false;
        unlight(flow);
        flow.figure.dataset.flow = live ? "live" : "still";
        if (live) {
            resume(flow);
        }
    });
};

const enhance = (figure: HTMLElement): void => {
    const nodes = [...figure.querySelectorAll<HTMLElement>(".kit-flow-node")];
    const flow: Flow = { figure, nodes, steps: stepsFor(nodes.length), step: 0, timer: undefined, travel: undefined, inView: false, pointed: false, drawing: false };
    const live = loopsRun();
    figure.dataset.flow = live ? "live" : "still";
    wirePointer(flow, live);
    if (!live) {
        return;
    }
    const arriving = !isInView(figure) && tokenMs("--motion-draw") > 0;
    if (arriving) {
        figure.dataset.drawn = "no";
        flow.drawing = true;
    }
    watchView(
        figure,
        () => {
            flow.inView = true;
            if (figure.dataset.drawn === "no") {
                figure.dataset.drawn = "yes";
                window.setTimeout(() => {
                    flow.drawing = false;
                    resume(flow);
                }, tokenMs("--motion-draw"));
                return;
            }
            resume(flow);
        },
        () => {
            flow.inView = false;
            pause(flow);
        },
    );
};

let started = false;

/** Sets every Flow on the page moving, once. */
export const startFlows = (): void => {
    if (started) {
        return;
    }
    started = true;
    for (const figure of document.querySelectorAll<HTMLElement>("[data-kit-flow]")) {
        enhance(figure);
    }
};
