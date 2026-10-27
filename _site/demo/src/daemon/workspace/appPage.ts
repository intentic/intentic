// The page a started dev server answers with, at the address a real sandbox hands out for it:
// `https://preview-<repo>--<app>-<sandbox>.<zone>` for a monorepo's app, `https://preview-<repo>-<sandbox>.<zone>` for a
// repository's own dev server, under the demo's reserved name. previewSites.ts answers those hosts.

const SANDBOX_LABEL = `demo`;
const ZONE = `demo.invalid`;

/** A started server's page: the shop's storefront as the app or repository named serves it. */
export const sitePage = (repo: string, app: string | undefined): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${app ?? repo} · ${repo}</title>
<style>
body { margin: 0; font: 15px/1.5 system-ui, sans-serif; color: #1c1917; background: #fafaf9; }
header { display: flex; justify-content: space-between; align-items: center; padding: 14px 24px; border-bottom: 1px solid #e7e5e4; }
header b { color: #c2410c; }
main { max-width: 880px; margin: 32px auto; padding: 0 24px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 16px; }
article { background: white; border: 1px solid #e7e5e4; border-radius: 10px; padding: 16px; }
button { background: #c2410c; color: white; border: 0; border-radius: 8px; padding: 6px 12px; cursor: pointer; }
footer { color: #78716c; font-size: 12px; text-align: center; margin: 40px 0; }
</style></head>
<body>
<header><span><b>Acme</b> ${app ?? repo}</span><button id="cart">Cart (0)</button></header>
<main>
<h1>Hand-made goods, shipped across Europe</h1>
<div class="grid">
<article><h3>Blue jug</h3><p>€38</p><button>Add</button></article>
<article><h3>Linen apron</h3><p>€24</p><button>Add</button></article>
<article><h3>Oak board</h3><p>€45</p><button>Add</button></article>
</div>
</main>
<footer>${app === undefined ? repo : `${repo}/_apps/${app}`} · served by Vite in the sandbox</footer>
<script>
let count = 0;
for (const add of document.querySelectorAll("article button")) {
    add.addEventListener("click", () => { count += 1; document.getElementById("cart").textContent = "Cart (" + count + ")"; });
}
</script>
</body></html>
`;

/** An app's preview address, the same for as long as the app is there. */
export const appPage = (repo: string, app: string): string => `https://preview-${repo}--${app}-${SANDBOX_LABEL}.${ZONE}`;

/** A repository's own dev server's preview address; a nested repository's slashes become dashes, as the daemon's labels do. */
export const repoPage = (repo: string): string => `https://preview-${repo.replaceAll(`/`, `-`)}-${SANDBOX_LABEL}.${ZONE}`;
