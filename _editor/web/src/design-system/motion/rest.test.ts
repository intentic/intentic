import "@intentic/testing/dom";
import { IDLE_MS, installMotionRest, LOOP_ATTRIBUTE, REST_ATTRIBUTE, UNWATCHED_MS } from "@intentic/ui/motion";

// Pins when the window's endless loops hold still and what is held: a CSS loop through its element's mark (motion.css
// pauses it), a script loop through its own pause, and nothing finite or scroll-driven, ever.

// jsdom runs no animations: the document's are these stand-ins, on a clock of their own, handed to rest.ts through
// `document.getAnimations`, which reads only timeline, effect.target, effect.getTiming, playState, pause and play.
const clock = {};
let focused = false;

class Loop {
    readonly element = document.createElement(`span`);
    readonly effect: { target: HTMLElement; getTiming: () => { iterations: number } };
    playState = `running`;
    played = 0;
    paused = 0;
    constructor(
        readonly timeline: object,
        iterations: number,
    ) {
        this.effect = { target: this.element, getTiming: () => ({ iterations }) };
    }
    pause(): void {
        this.paused++;
        this.playState = `paused`;
    }
    play(): void {
        this.played++;
        this.playState = `running`;
    }
}

const animations: Loop[] = [];

const loop = ({ css, iterations = Infinity, timeline = clock }: { css: boolean; iterations?: number; timeline?: object }): Loop => {
    const made = new Loop(timeline, iterations);
    // A CSSAnimation is told from a script's by its name.
    if (css) {
        Object.assign(made, { animationName: `turn` });
    }
    animations.push(made);
    return made;
};

const resting = (): boolean => document.documentElement.hasAttribute(REST_ATTRIBUTE);
let undo: () => void = () => {};

beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(1_000_000);
    animations.length = 0;
    focused = false;
    Object.defineProperty(document, `timeline`, { value: clock, configurable: true });
    Object.defineProperty(document, `getAnimations`, { value: () => [...animations], configurable: true });
    Object.defineProperty(document, `hasFocus`, { value: () => focused, configurable: true });
    Object.defineProperty(document, `visibilityState`, { value: `visible`, configurable: true });
});

afterEach(() => {
    undo();
    jest.useRealTimers();
});

const wait = (ms: number): void => {
    jest.advanceTimersByTime(ms);
};

describe(`installMotionRest`, () => {
    it(`holds every endless loop once an unfocused window goes untouched, and nothing finite or scroll-driven`, () => {
        const css = loop({ css: true });
        const script = loop({ css: false });
        const arrival = loop({ css: true, iterations: 1 });
        const scrolled = loop({ css: true, timeline: {} });
        undo = installMotionRest();

        wait(UNWATCHED_MS - 1);
        expect(resting()).toBe(false);
        wait(1);

        expect(resting()).toBe(true);
        expect(css.element.hasAttribute(LOOP_ATTRIBUTE)).toBe(true);
        expect(script.paused).toBe(1);
        expect(arrival.element.hasAttribute(LOOP_ATTRIBUTE)).toBe(false);
        expect(scrolled.element.hasAttribute(LOOP_ATTRIBUTE)).toBe(false);
    });

    it(`lets them go on at the first input`, () => {
        const script = loop({ css: false });
        undo = installMotionRest();
        wait(UNWATCHED_MS);
        expect(resting()).toBe(true);

        window.dispatchEvent(new Event(`pointermove`));

        expect(resting()).toBe(false);
        expect(script.played).toBe(1);
    });

    it(`gives a focused window a full minute`, () => {
        focused = true;
        loop({ css: true });
        undo = installMotionRest();

        wait(UNWATCHED_MS * 2);
        expect(resting()).toBe(false);
        wait(IDLE_MS);

        expect(resting()).toBe(true);
    });

    it(`brings the look forward when the window loses focus`, () => {
        focused = true;
        undo = installMotionRest();
        wait(UNWATCHED_MS);
        expect(resting()).toBe(false);

        focused = false;
        window.dispatchEvent(new Event(`blur`));

        expect(resting()).toBe(true);
    });

    it(`rests at once when the window is hidden, and wakes when it is back`, () => {
        focused = true;
        undo = installMotionRest();

        Object.defineProperty(document, `visibilityState`, { value: `hidden`, configurable: true });
        document.dispatchEvent(new Event(`visibilitychange`));
        expect(resting()).toBe(true);

        Object.defineProperty(document, `visibilityState`, { value: `visible`, configurable: true });
        document.dispatchEvent(new Event(`visibilitychange`));
        expect(resting()).toBe(false);
    });

    it(`counts working inside an embedded frame as somebody there`, () => {
        focused = true;
        const frame = document.createElement(`iframe`);
        document.body.append(frame);
        frame.focus();
        Object.defineProperty(document, `activeElement`, { value: frame, configurable: true });
        undo = installMotionRest();

        wait(IDLE_MS * 3);
        expect(resting()).toBe(false);

        Object.defineProperty(document, `activeElement`, { value: document.body, configurable: true });
        wait(IDLE_MS);
        expect(resting()).toBe(true);
        frame.remove();
    });

    it(`holds a loop that starts while the window rests`, () => {
        undo = installMotionRest();
        wait(UNWATCHED_MS);
        const late = loop({ css: true });

        document.dispatchEvent(new Event(`animationstart`));

        expect(late.element.hasAttribute(LOOP_ATTRIBUTE)).toBe(true);
    });
});
