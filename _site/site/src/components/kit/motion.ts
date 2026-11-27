// What the kit's client scripts share: the motion tokens read where the system defines them (styles/system.css), the
// app's curve as a function, and the one rule for when a figure moves ("a third of it in view").

const root = (): CSSStyleDeclaration => getComputedStyle(document.documentElement);

/** A duration token in milliseconds. Under reduced motion system.css zeroes most of them, and this reads the zero. */
export const tokenMs = (name: string): number => {
    const value = root().getPropertyValue(name).trim();
    const number = Number.parseFloat(value);
    if (Number.isNaN(number)) {
        return 0;
    }
    return value.endsWith("ms") ? number : value.endsWith("s") ? number * 1000 : number;
};

/** Whether a loop may run: `--motion-loop` is `paused` under reduced motion. */
export const loopsRun = (): boolean => root().getPropertyValue("--motion-loop").trim() !== "paused";

/** A CSS `cubic-bezier()` token as a function of progress, so a count and a glide share the app's curve. */
export const easing = (name: string): ((progress: number) => number) => {
    const match = /cubic-bezier\(([^)]+)\)/u.exec(root().getPropertyValue(name));
    const points = match?.[1]?.split(",").map((part) => Number.parseFloat(part));
    if (points?.length !== 4 || points.some((point) => Number.isNaN(point))) {
        return (progress) => progress;
    }
    const [x1 = 0, y1 = 0, x2 = 1, y2 = 1] = points;
    const at = (t: number, a: number, b: number): number => 3 * a * (1 - t) ** 2 * t + 3 * b * (1 - t) * t ** 2 + t ** 3;
    const slope = (t: number, a: number, b: number): number => 3 * a * (1 - t) ** 2 + 6 * (b - a) * (1 - t) * t + 3 * (1 - b) * t ** 2;
    return (progress) => {
        if (progress <= 0 || progress >= 1) {
            return Math.min(1, Math.max(0, progress));
        }
        // Newton's method for the t whose x is this progress; eight steps are well under a pixel for any curve here.
        let t = progress;
        for (let step = 0; step < 8; step += 1) {
            const error = at(t, x1, x2) - progress;
            const gradient = slope(t, x1, x2);
            if (Math.abs(error) < 1e-5 || gradient === 0) {
                break;
            }
            t -= error / gradient;
        }
        return at(Math.min(1, Math.max(0, t)), y1, y2);
    };
};

/** A figure starts when a third of it is in view and pauses when it leaves (DESIGN.md, "Motion"). */
const IN_VIEW = 1 / 3;

/** Whether a third of the element is on screen right now, for deciding at load whether there is anything to arrive. */
export const isInView = (element: Element): boolean => {
    const box = element.getBoundingClientRect();
    if (box.height === 0) {
        return false;
    }
    const visible = Math.min(box.bottom, window.innerHeight) - Math.max(box.top, 0);
    return visible / Math.min(box.height, window.innerHeight) >= IN_VIEW;
};

/** Calls `enter` once a third of the element is on screen, and `leave` once none of it is. In between, nothing
 *  changes: a figure half scrolled away keeps moving, and one barely peeking in has not started. */
export const watchView = (element: Element, enter: () => void, leave: () => void): void => {
    if (!("IntersectionObserver" in window)) {
        enter();
        return;
    }
    new IntersectionObserver(
        (entries) => {
            for (const entry of entries) {
                if (!entry.isIntersecting) {
                    leave();
                } else if (entry.intersectionRatio >= IN_VIEW - 0.01) {
                    enter();
                }
            }
        },
        { threshold: [0, IN_VIEW] },
    ).observe(element);
};
