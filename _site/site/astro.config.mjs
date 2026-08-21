import sitemap from "@astrojs/sitemap";
import { docsSearch, lastModForUrl, llmsText } from "@intentic-dev/astro-integrations";
import { developersBook, developersHref, developersPages } from "@intentic-dev/site-content/developers";
import { bookHref, bookPlacements } from "@intentic-dev/site-content/book";
import { compareHref, comparePages } from "@intentic-dev/site-content/compare";
import { docsBook, docsHref, docsPages } from "@intentic-dev/site-content/docs";
import { guidePages, guidesHref } from "@intentic-dev/site-content/guides";
import { landingContent } from "@intentic-dev/site-content/landing";
import { productHref, productPages } from "@intentic-dev/site-content/product";
import { referenceBook, referenceHref, referencePages } from "@intentic-dev/site-content/reference";
import { ORG_NAME, SITE_URL } from "@intentic-dev/site-content/site";
import tailwindcss from "@tailwindcss/vite";
import indexNow from "astro-indexnow";
import astroOpenGraphImages, { getImagePath } from "astro-opengraph-images";
import { defineConfig } from "astro/config";
import { createReadStream, existsSync } from "node:fs";
import { DESKTOP_ROUTES, RELEASES_URL } from "./src/lib/desktop-downloads";
import { ogCard, ogFonts } from "./scripts/og-template.mjs";

const isIndexNowDisabled = process.env.INDEXNOW_ENABLED === "0";

// Absent when the Inter TTFs are not checked out; the OG integration is then left out entirely and BaseLayout
// falls back to the static logo card, which is the same bargain the old in-house integration made.
const ogFontFaces = ogFonts();
const site = new URL(SITE_URL);

// Dev serves paths with or without the trailing slash; builds keep "always" so canonical URLs
// stay slashed and hosting normalizes requests.
const isDev = process.argv.includes("dev");

/* THE DOWNLOAD PATHS, IN DEV. /desktop/windows and its siblings are the worker's (worker.ts), and the worker
 * does not run under `astro dev`, so every download link on the site, including the button in the hero,
 * answered with this site's own 404 page on a developer's machine. That is the worst possible place for a
 * dead link to hide: it looks broken exactly where somebody is checking their work, and looks fine in the one
 * place nobody tests by hand.
 *
 * The path table is the worker's own, so the two cannot drift. The behaviour is the worker's minus the part
 * that needs the network: a locally staged installer is handed over as a real download, and everything else
 * goes to the releases page, which is also the worker's fallback when it cannot resolve a named asset, so a
 * developer sees a real destination rather than a stub. */
const desktopDevRoutes = {
    name: "intentic:desktop-dev-routes",
    apply: "serve",
    configureServer(server) {
        server.middlewares.use((request, response, next) => {
            const pathname = new URL(request.url ?? "/", "http://localhost").pathname.replace(/\/$/u, "");
            const route = DESKTOP_ROUTES[pathname];
            if (route === undefined) return next();

            const staged = new URL(`./public/desktop/${route.staged}`, import.meta.url);
            if (existsSync(staged)) {
                response.writeHead(200, {
                    "content-type": "application/octet-stream",
                    "content-disposition": `attachment; filename="${route.staged}"`,
                });
                createReadStream(staged).pipe(response);
                return undefined;
            }

            response.writeHead(302, { location: `${RELEASES_URL}/latest` });
            response.end();
            return undefined;
        });
    },
};

export default defineConfig({
    site: SITE_URL,
    trailingSlash: isDev ? "ignore" : "always",
    build: {
        inlineStylesheets: "always",
    },
    vite: {
        plugins: [tailwindcss(), desktopDevRoutes],
        define: {
            "import.meta.env.PUBLIC_OG_PER_PAGE": JSON.stringify(ogFontFaces !== undefined),
        },
        /* The interactive demo (@intentic-dev/demo) at DEMO_PATH. In production it is a BUILD output copied into
         * this package's public/demo/, and the worker serves its history routes (worker.ts). Neither exists under
         * `astro dev`: the demo isn't built, and public/demo/index.html (if someone did build it) would answer
         * only its exact path, so the hero's iframe loaded /demo/ and got this site's 404 page.
         *
         * So in dev the demo is served by the demo, at its own dev server, through this proxy: the live app with
         * HMR, its own SPA fallback, and no build step between an edit and the overlay. Run it alongside:
         *     pnpm -C _site/demo dev
         * Port from _site/demo/vite.config.ts (strictPort, so it is this or nothing). When it isn't running the
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
                                          `<pre style="background:#151517;padding:1rem;border-radius:.5rem">pnpm -C _site/demo dev</pre>` +
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
            // The search index is an endpoint, not a page: it has no title, no content a reader could land on,
            // and a crawler that fetches it learns the whole corpus twice.
            filter: (page) => !page.endsWith("/404/") && !page.endsWith("/404") && !page.endsWith(".json"),
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
        // that the tag and the file it wrote agree, so reading the page's own tag keeps that decision in one
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
                "intentic runs each coding agent in its own Docker sandbox on hardware you own, with the dev-tools its job needs really installed, the systems it operates wired in as capabilities, and its context curated for one job. The platform stores only your identity and the sandbox's URL; your code and credentials never leave your machine. One free starter sandbox per account can instead be hosted by us on rented infrastructure, in which case that workspace lives on our provider's disk: see /privacy/ and /dpa/. Every page below is also served as Markdown at the same URL with a .md suffix.",
            sections: [
                // /about/ sits under Overview rather than Optional: "who is behind this" is the question an
                // answer engine most often has to resolve about a young domain, and the page is the answer.
                { label: "Overview", paths: ["/", "/about/"] },
                { label: "Product", paths: ["/product/", ...productPages.map((page) => productHref(page.slug))] },
                /* The guides, above Compare because they answer the question a reader has BEFORE they know
                 * this product exists: "how do I run several agents at once", not "intentic or Conductor".
                 * Each page opens with a standalone answer, so this section is the part of the site a model
                 * can quote without needing the rest of it. */
                { label: "Guides", paths: [guidesHref(""), ...guidePages.map((page) => guidesHref(page.slug))] },
                { label: "Compare", paths: [compareHref(""), ...comparePages.map((page) => compareHref(page.slug))] },
                { label: "Docs", paths: docsPages.map((page) => docsHref(page.id)) },
                // The authoring book as its own section, not folded into Docs: an answer engine asked "how do I
                // write an intentic extension" should be able to reach the eight pages that answer it without
                // reading the seventeen that do not.
                { label: "Extension API", paths: developersPages.map((page) => developersHref(page.id)) },
                /* The wire API, as its own section and after the authoring one. A model asked what an intentic
                 * sandbox can be told to DO has 37 pages here that answer it exactly, each one a route group
                 * with its calls, their inputs and their answers, and none of that is derivable from the prose
                 * sections above. It goes last of the content sections because it is the longest and the most
                 * specific: a reader who needs it knows they need it. */
                { label: "Sandbox HTTP API", paths: referencePages.map((page) => referenceHref(page.id)) },
                { label: "Optional", paths: ["/privacy/", "/terms/", "/acceptable-use/", "/dpa/", "/subprocessors/"] },
            ],
        }),
        /* The search index, rebuilt from the pages that were just written: it replaces the near-empty file the
         * /search.json route emits in a build. Driven by the TREES, so a page no rail can reach is never indexed
         * and the shelf a result names is the one the reader navigates by. All three books feed one index: a
         * reader looking a word up should not have to know which of them documents it, and the generated book
         * needs it most of all, because "which group holds the route that stops a turn" is exactly the question
         * a reader arrives with and cannot answer from a rail of 37 labels. */
        docsSearch({
            pages: [docsBook, developersBook, referenceBook].flatMap((book) =>
                bookPlacements(book).map(({ page, section }) => ({
                    url: bookHref(book, page.id),
                    title: page.title,
                    section: section.label,
                    blurb: page.blurb,
                })),
            ),
        }),
        // Submission runs at build:done, which on a deploy box is BEFORE the upload, so the first build after
        // the key file changes can be refused (403) while the old file is still live. astro-indexnow retries
        // 429/5xx only and leaves its cache untouched on failure, so that case self-heals on the next build
        // rather than being waited out. CI never deploys and sets INDEXNOW_ENABLED=0.
        indexNow({
            key: "31005b25581392e405272cfb8ee63e9a",
            enabled: !isIndexNowDisabled,
        }),
    ],
});
