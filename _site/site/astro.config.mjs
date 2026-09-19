import sitemap from "@astrojs/sitemap";
import { docsSearch, lastModForUrl, llmsText } from "@intentic/astro-integrations";
import { developersBook, developersHref, developersPages } from "@intentic/site-content/developers";
import { bookHref, bookPlacements } from "@intentic/site-content/book";
import { compareHref, comparePages } from "@intentic/site-content/compare";
import { docsBook, docsHref, docsPages } from "@intentic/site-content/docs";
import { guidePages, guidesHref } from "@intentic/site-content/guides";
import { landingContent } from "@intentic/site-content/landing";
import { productHref, productPages } from "@intentic/site-content/product";
import { referenceBook, referenceHref, referencePages } from "@intentic/site-content/reference";
import { ORG_NAME, SITE_URL } from "@intentic/site-content/site";
import tailwindcss from "@tailwindcss/vite";
import astroOpenGraphImages, { getImagePath } from "astro-opengraph-images";
import { defineConfig } from "astro/config";
import { createReadStream, existsSync } from "node:fs";
import { DESKTOP_ROUTES, RELEASES_URL } from "./src/lib/desktop-downloads";
import { ogCard, ogFonts } from "./scripts/og-template.mjs";
import { postPaths } from "./scripts/post-slugs.mjs";
import { sourceFirstWorkspace } from "./scripts/source-first.mjs";

// Absent without the Inter TTFs checked out; OG then skips, BaseLayout falls back to the static logo.
const ogFontFaces = ogFonts();
const site = new URL(SITE_URL);

// Dev serves paths with or without the trailing slash; builds keep "always" so canonical URLs stay slashed.
const isDev = process.argv.includes("dev");

// Worker.ts serves /desktop/* in production but not under `astro dev`, so this mirrors its path table (can't drift) and
// behaviour there, minus the network fallback.
const desktopDevRoutes = {
    name: "intentic:desktop-dev-routes",
    apply: "serve",
    configureServer(server) {
        server.middlewares.use((request, response, next) => {
            const pathname = new URL(request.url ?? "/", "http://localhost").pathname.replace(/\/$/u, "");
            const route = DESKTOP_ROUTES[pathname];
            if (route === undefined) {
                return next();
            }

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
        plugins: [sourceFirstWorkspace(), tailwindcss(), desktopDevRoutes],
        define: {
            "import.meta.env.PUBLIC_OG_PER_PAGE": JSON.stringify(ogFontFaces !== undefined),
        },
        // Matches tsconfig.astro.json's `@intentic/src` condition; sourceFirstWorkspace() covers what this can't.
        resolve: {
            conditions: ["@intentic/src", "@intentic/src", "@intentic/src", "import", "module", "browser", "default"],
        },
        // Dev proxies /demo to its own dev server: run `pnpm -C _site/demo dev` (port from its vite.config.ts).
        server: isDev
            ? {
                  proxy: {
                      "/demo": {
                          target: "http://localhost:47146",
                          ws: true,
                          configure: (proxy) => {
                              proxy.on("error", (_error, _request, response) => {
                                  if (!("writeHead" in response)) {
                                      return;
                                  }
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
            // The search index is an endpoint, not a page: no title, nothing to land on; indexing it doubles the
            // corpus.
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
                if (lastmod) {
                    item.lastmod = lastmod;
                }
                return item;
            },
        }),
        // Only pages that asked get a card; the integration's file must match BaseLayout's og:image tag.
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
                "intentic runs each coding agent in its own Docker sandbox, with the dev-tools its job needs really installed, the systems it operates wired in as capabilities, and its context curated for one job. The platform stores only your identity and the sandbox's URL; your code and credentials never leave your machine. One free starter sandbox per account can instead be hosted by us on rented infrastructure, in which case that workspace lives on our provider's disk: see /privacy/ and /dpa/. Every page below is also served as Markdown at the same URL with a .md suffix.",
            sections: [
                // /about/ sits under Overview, not Optional: it answers "who's behind this" for a young domain.
                { label: "Overview", paths: ["/", "/about/"] },
                { label: "Product", paths: ["/product/", ...productPages.map((page) => productHref(page.slug))] },
                // Guides sit above Compare: they answer what a reader asks before knowing this product exists.
                { label: "Guides", paths: [guidesHref(""), ...guidePages.map((page) => guidesHref(page.slug))] },
                { label: "Compare", paths: [compareHref(""), ...comparePages.map((page) => compareHref(page.slug))] },
                // The only shelf here whose pages argue a position, not describe the product; named for that reason.
                { label: "Blog", paths: ["/blog/", ...postPaths()] },
                { label: "Docs", paths: docsPages.map((page) => docsHref(page.id)) },
                // Own section, not folded into Docs, so an extension-writing query need not wade through docs pages.
                { label: "Extension API", paths: developersPages.map((page) => developersHref(page.id)) },
                // Own section after the authoring one: route-group answers no prose derives; last as the most specific.
                { label: "Sandbox HTTP API", paths: referencePages.map((page) => referenceHref(page.id)) },
                { label: "Optional", paths: ["/privacy/", "/terms/", "/acceptable-use/", "/dpa/", "/subprocessors/"] },
            ],
        }),
        // Rebuilds the search index from the pages just written, driven by the trees so an unreachable page is never
        // indexed. All three books feed one index, so a reader doesn't need to know which documents a term.
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
    ],
});
