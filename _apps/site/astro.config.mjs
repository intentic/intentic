import sitemap from "@astrojs/sitemap";
import { lastModForUrl, llmsText } from "@intentic-dev/astro-integrations";
import { compareHref, comparePages } from "@intentic-dev/site-content/compare";
import { docsHref, docsPages } from "@intentic-dev/site-content/docs";
import { landingContent } from "@intentic-dev/site-content/landing";
import { productHref, productPages } from "@intentic-dev/site-content/product";
import { ORG_NAME, SITE_URL } from "@intentic-dev/site-content/site";
import tailwindcss from "@tailwindcss/vite";
import indexNow from "astro-indexnow";
import astroOpenGraphImages, { getImagePath } from "astro-opengraph-images";
import { defineConfig } from "astro/config";
import { ogCard, ogFonts } from "./scripts/og-template.mjs";

const isIndexNowDisabled = process.env.INDEXNOW_ENABLED === "0";

// Absent when the Inter TTFs are not checked out; the OG integration is then left out entirely and BaseLayout
// falls back to the static logo card, which is the same bargain the old in-house integration made.
const ogFontFaces = ogFonts();
const site = new URL(SITE_URL);

// Dev serves paths with or without the trailing slash; builds keep "always" so canonical URLs
// stay slashed and hosting normalizes requests.
const isDev = process.argv.includes("dev");

export default defineConfig({
    site: SITE_URL,
    trailingSlash: isDev ? "ignore" : "always",
    build: {
        inlineStylesheets: "always",
    },
    vite: {
        plugins: [tailwindcss()],
        define: {
            "import.meta.env.PUBLIC_OG_PER_PAGE": JSON.stringify(ogFontFaces !== undefined),
        },
        /* The interactive demo (@intentic-dev/demo) at DEMO_PATH. In production it is a BUILD output copied into
         * this package's public/demo/, and the worker serves its history routes (worker.ts). Neither exists under
         * `astro dev`: the demo isn't built, and public/demo/index.html — if someone did build it — would answer
         * only its exact path, so the hero's iframe loaded /demo/ and got this site's 404 page.
         *
         * So in dev the demo is served by the demo, at its own dev server, through this proxy: the live app with
         * HMR, its own SPA fallback, and no build step between an edit and the overlay. Run it alongside:
         *     pnpm -C _apps/demo dev
         * Port from _apps/demo/vite.config.ts (strictPort, so it is this or nothing). When it isn't running the
         * proxy says so in the frame rather than failing as a bare gateway error. */
        server: isDev
            ? {
                  proxy: {
                      "/demo": {
                          target: "http://localhost:47146",
                          ws: true,
                          configure: (proxy) => {
                              proxy.on("error", (_error, _request, response) => {
                                  if (!("writeHead" in response)) return;
                                  response.writeHead(503, { "content-type": "text/html; charset=utf-8" });
                                  response.end(
                                      `<!doctype html><meta charset="utf-8"><title>Demo not running</title>` +
                                          `<body style="font:16px/1.6 system-ui;background:#0b0b0c;color:#e7e7e9;padding:3rem">` +
                                          `<h1 style="color:#ff7a1a">The demo dev server isn't running</h1>` +
                                          `<p>Its dev server serves <code>/demo/</code> for this site's dev server. Start it:</p>` +
                                          `<pre style="background:#151517;padding:1rem;border-radius:.5rem">pnpm -C _apps/demo dev</pre>` +
                                          `<p>Production is unaffected: there the demo is built into <code>public/demo/</code>.</p>`,
                                  );
                              });
                          },
                      },
                  },
              }
            : undefined,
    },
    integrations: [
        sitemap({
            filter: (page) => !page.endsWith("/404/") && !page.endsWith("/404"),
            changefreq: "monthly",
            priority: 0.7,
            serialize(item) {
                const p = new URL(item.url).pathname;
                if (p === "/") {
                    item.priority = 1.0;
                    item.changefreq = "weekly";
                }
                const lastmod = lastModForUrl(item.url);
                if (lastmod) item.lastmod = lastmod;
                return item;
            },
        }),
        // Only the pages that ASKED for a per-page card get one. BaseLayout points og:image at the generated
        // path when the page has metadata and at the static logo otherwise, and the integration hard-asserts
        // that the tag and the file it wrote agree — so reading the page's own tag keeps that decision in one
        // place instead of duplicating BaseLayout's condition here, where the two could drift apart.
        ...(ogFontFaces === undefined
            ? []
            : [
                  astroOpenGraphImages({
                      options: { width: 1200, height: 628, fonts: ogFontFaces },
                      filter: ({ url, image }) => image === getImagePath({ url: new URL(url), site }),
                      render: ogCard,
                  }),
              ]),
        llmsText({
            name: ORG_NAME,
            summary: landingContent.meta.description,
            details:
                "intentic runs each coding agent in its own Docker sandbox on hardware you own — the dev-tools its job needs really installed, the systems it operates wired in as capabilities, and its context curated for one job. The platform stores only your identity and the sandbox's URL; your code and credentials never leave your machine. Every page below is also served as Markdown at the same URL with a .md suffix.",
            sections: [
                // /about/ sits under Overview rather than Optional: "who is behind this" is the question an
                // answer engine most often has to resolve about a young domain, and the page is the answer.
                { label: "Overview", paths: ["/", "/about/"] },
                { label: "Product", paths: ["/product/", ...productPages.map((page) => productHref(page.slug))] },
                { label: "Compare", paths: [compareHref(""), ...comparePages.map((page) => compareHref(page.slug))] },
                { label: "Docs", paths: docsPages.map((page) => docsHref(page.id)) },
                { label: "Optional", paths: ["/privacy/", "/terms/"] },
            ],
        }),
        // Submission runs at build:done, which on a deploy box is BEFORE the upload — so the first build after
        // the key file changes can be refused (403) while the old file is still live. astro-indexnow retries
        // 429/5xx only and leaves its cache untouched on failure, so that case self-heals on the next build
        // rather than being waited out. CI never deploys and sets INDEXNOW_ENABLED=0.
        indexNow({
            key: "31005b25581392e405272cfb8ee63e9a",
            enabled: !isIndexNowDisabled,
        }),
    ],
});
