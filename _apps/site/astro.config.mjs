import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sitemap from "@astrojs/sitemap";
import { indexnow, lastModForUrl, llmsText, ogImages } from "@intentic-dev/astro-integrations";
import { docsHref, docsPages } from "@intentic-dev/site-content/docs";
import { landingContent } from "@intentic-dev/site-content/landing";
import { productHref, productPages } from "@intentic-dev/site-content/product";
import { ORG_NAME } from "@intentic-dev/site-content/site";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

const isIndexNowDisabled = process.env.INDEXNOW_ENABLED === "0";

const projectRoot = fileURLToPath(new URL("./", import.meta.url));
const hasOgFonts =
    existsSync(path.join(projectRoot, "scripts/fonts/Inter-Regular.ttf")) && existsSync(path.join(projectRoot, "scripts/fonts/Inter-Bold.ttf"));

// Dev serves paths with or without the trailing slash; builds keep "always" so canonical URLs
// stay slashed and hosting normalizes requests.
const isDev = process.argv.includes("dev");

export default defineConfig({
    site: "https://intentic.dev",
    trailingSlash: isDev ? "ignore" : "always",
    build: {
        inlineStylesheets: "always",
    },
    vite: {
        plugins: [tailwindcss()],
        define: {
            "import.meta.env.PUBLIC_OG_PER_PAGE": JSON.stringify(hasOgFonts),
        },
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
        ogImages(),
        llmsText({
            name: ORG_NAME,
            summary: landingContent.meta.description,
            details:
                "intentic runs each coding agent in its own Docker sandbox on hardware you own — the dev-tools its job needs really installed, the systems it operates wired in as capabilities, and its context curated for one job. The platform stores only your identity and the sandbox's URL; your code and credentials never leave your machine. Every page below is also served as Markdown at the same URL with a .md suffix.",
            sections: [
                { label: "Overview", paths: ["/"] },
                { label: "Product", paths: ["/product/", ...productPages.map((page) => productHref(page.slug))] },
                { label: "Docs", paths: docsPages.map((page) => docsHref(page.id)) },
                { label: "Optional", paths: ["/privacy/", "/terms/"] },
            ],
        }),
        indexnow({
            key: "31005b25581392e405272cfb8ee63e9a",
            enabled: !isIndexNowDisabled,
        }),
    ],
});
