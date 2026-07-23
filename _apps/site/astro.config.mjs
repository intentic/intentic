import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sitemap from "@astrojs/sitemap";
import { indexnow, lastModForUrl, ogImages } from "@intentic-dev/astro-integrations";
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
        indexnow({
            key: "31005b25581392e405272cfb8ee63e9a",
            enabled: !isIndexNowDisabled,
        }),
    ],
});
