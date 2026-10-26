export function observeHeroCta(): void {
    // Keep the bar action visible once the hero action scrolls behind it.
    const bar = document.getElementById("site-bar");

    const heroCta = document.querySelector("[data-hero-cta]");
    if (bar && heroCta && "IntersectionObserver" in window) {
        // The bar's clamped height changes with the viewport, but an observer's pixel rootMargin never updates.
        let ctaObserver: IntersectionObserver | undefined;
        // Resize entries provide the initial height after layout without forcing an early synchronous measurement.
        new ResizeObserver(([resize]) => {
            const height = resize?.borderBoxSize[0]?.blockSize ?? resize?.contentRect.height ?? 0;
            ctaObserver?.disconnect();
            ctaObserver = new IntersectionObserver(
                (entries) => {
                    for (const entry of entries) {
                        bar.toggleAttribute("data-cta-shown", !entry.isIntersecting);
                    }
                },
                { rootMargin: `-${Math.round(height)}px 0px 0px 0px`, threshold: 0 },
            );
            ctaObserver.observe(heroCta);
        }).observe(bar);
    }
}
