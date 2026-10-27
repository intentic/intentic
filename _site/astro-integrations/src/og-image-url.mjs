// @ts-check
// Where a page's OpenGraph card lives. Pure path math with no image dependencies, so the layout that names the card in
// its <meta> and the integration that draws it (og-images.mjs) share one rule without bundling satori into the site.

/**
 * The card's absolute URL for a page: `/docs/` → `/docs/index.png`, `/blog/post` → `/blog/post.png`. The 404 and 500
 * pages are written as top-level files (`dist/404.html`), so their cards are `/404.png` and `/500.png`.
 * @param {URL} pageUrl
 * @returns {string}
 */
export function ogImageUrl(pageUrl) {
    const { pathname } = pageUrl;
    const card = pathname.endsWith("/") ? `${pathname}index.png` : `${pathname}.png`;
    const flat = card === "/404/index.png" || card === "/500/index.png" ? `${card.slice(0, 4)}.png` : card;
    return new URL(flat, pageUrl).href;
}
