// One IntersectionObserver for every tile on the desk, rather than one each. A folder of thousands handed the browser
// thousands of observers to keep and notify, which cost more than the thing they were deferring.

// How far ahead of the viewport a tile counts as worth loading.
const ROOT_MARGIN = `240px`;

const waiting = new Map<Element, () => void>();
let observer: IntersectionObserver | undefined;

const shared = (): IntersectionObserver => {
    observer ??= new IntersectionObserver(
        (hits) => {
            for (const hit of hits) {
                const near = hit.isIntersecting ? waiting.get(hit.target) : undefined;
                if (near !== undefined) {
                    // One-shot: what it triggers is a fetch, and the fetch caches itself from then on.
                    waiting.delete(hit.target);
                    observer?.unobserve(hit.target);
                    near();
                }
            }
        },
        { rootMargin: ROOT_MARGIN },
    );
    return observer;
};

/** Call `near` once `el` comes within reach of the viewport, or immediately if it already is. */
export const whenNear = (el: Element, near: () => void): void => {
    waiting.set(el, near);
    shared().observe(el);
};

/** Stop waiting on `el`; safe to call whether or not it ever fired. */
export const stopWaiting = (el: Element): void => {
    waiting.delete(el);
    observer?.unobserve(el);
};
