// Stat.astro's count. Each figure waits at zero until a third of it is in view, then counts to the value its HTML
// already holds over `--motion-count` on the app's curve; its meter fills alongside. Once, never again: a number that
// re-counts every time it scrolls past is decoration. Under reduced motion the duration token is zero, so the figure
// is never taken down to zero at all.

import { easing, isInView, tokenMs, watchView } from "./motion";

const count = (live: HTMLElement, stat: HTMLElement): void => {
    const target = Number(live.dataset.to);
    const decimals = Number(live.dataset.decimals ?? "0");
    const format = new Intl.NumberFormat(live.dataset.locale ?? "en-GB", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    const final = format.format(target);
    const duration = tokenMs("--motion-count");
    stat.dataset.stat = "counting";
    if (duration === 0) {
        live.textContent = final;
        stat.dataset.stat = "done";
        return;
    }
    const curve = easing("--ease-smooth");
    const start = performance.now();
    const step = (now: number): void => {
        const progress = Math.min(1, (now - start) / duration);
        live.textContent = progress === 1 ? final : format.format(curve(progress) * target);
        if (progress < 1) {
            requestAnimationFrame(step);
        } else {
            stat.dataset.stat = "done";
        }
    };
    requestAnimationFrame(step);
};

const arm = (stat: HTMLElement): void => {
    const live = stat.querySelector<HTMLElement>(".kit-stat-live");
    if (live === null || tokenMs("--motion-count") === 0) {
        return;
    }
    // A stat already on screen at load has nothing to arrive into: it keeps its value rather than flashing to zero.
    if (isInView(stat)) {
        return;
    }
    live.textContent = new Intl.NumberFormat(live.dataset.locale ?? "en-GB", {
        minimumFractionDigits: Number(live.dataset.decimals ?? "0"),
    }).format(0);
    stat.dataset.stat = "waiting";
    let done = false;
    watchView(
        stat,
        () => {
            if (!done) {
                done = true;
                // One frame at zero first, so the meter's transition has a start to run from.
                requestAnimationFrame(() => count(live, stat));
            }
        },
        () => undefined,
    );
};

let started = false;

/** Arms every counted Stat on the page, once. */
export const startStats = (): void => {
    if (started) {
        return;
    }
    started = true;
    for (const stat of document.querySelectorAll<HTMLElement>("[data-kit-stat]")) {
        arm(stat);
    }
};
