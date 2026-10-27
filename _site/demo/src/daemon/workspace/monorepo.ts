// What a repository cloned into the shop looks like: a pnpm workspace in the layout `intentic scaffold` writes, apps
// under `_apps/`, shared packages under `packages/`, each with its own package.json, a test or two, and a layers.json
// where the package declares its insides. The Apps, Dependencies and Tests views read every one of these files the way
// the daemon reads them on disk, so a clone, and every app added to it after, is drawn from its files alone.

/** The kinds of app the shop's source repo knows how to scaffold (its templates.json). */
export const APP_TEMPLATES = [
    { key: `web`, label: `Web app`, description: `A Vite + React front end with routing, the shared UI kit wired in, and a Vitest suite.` },
    { key: `api`, label: `HTTP API`, description: `A Hono server on Node with typed routes, request validation and a health check.` },
    { key: `site`, label: `Content site`, description: `An Astro site for marketing pages and docs, prerendered, with the shared styles.` },
    { key: `worker`, label: `Background worker`, description: `A queue consumer for jobs like emails and webhooks, with retries and a dead-letter log.` },
] as const;

export type AppTemplate = (typeof APP_TEMPLATES)[number][`key`];

// A manifest's shape: what package.json and layers.json hold.
type JsonValue = string | number | boolean | readonly JsonValue[] | { readonly [key: string]: JsonValue };

const json = (value: JsonValue): string => `${JSON.stringify(value, undefined, 4)}\n`;

// The package one app's template writes: its manifest, an entry, and a test beside it.
const TEMPLATE_FILES = {
    web: (scope, app) => [
        [
            `package.json`,
            json({
                name: `${scope}/${app}`,
                private: true,
                type: `module`,
                intentic: { template: `web` },
                scripts: { dev: `vite --port $PORT --host`, build: `vite build`, test: `vitest run` },
                dependencies: { [`${scope}/ui`]: `workspace:*`, [`${scope}/api-client`]: `workspace:*`, react: `^19.2.0`, "react-dom": `^19.2.0` },
                devDependencies: { [`${scope}/config`]: `workspace:*`, vite: `^8.0.0`, vitest: `^3.2.4` },
            }),
        ],
        [`index.html`, `<!doctype html>\n<html lang="en">\n  <head><meta charset="utf-8" /><title>${app}</title></head>\n  <body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>\n</html>\n`],
        [`vite.config.ts`, `import { defineConfig } from "vite";\nimport { viteConfig } from "${scope}/config/vite";\n\nexport default defineConfig(viteConfig());\n`],
        [
            `src/main.tsx`,
            `import { createRoot } from "react-dom/client";\nimport { App } from "./App";\n\ncreateRoot(document.getElementById("root")!).render(<App />);\n`,
        ],
        [
            `src/App.tsx`,
            `import { Button, Page } from "${scope}/ui";\nimport { useCart } from "./cart/useCart";\n\nexport const App = () => {\n    const cart = useCart();\n    return (\n        <Page title="${app}">\n            <Button onClick={cart.checkout}>Checkout ({cart.count})</Button>\n        </Page>\n    );\n};\n`,
        ],
        [
            `src/cart/useCart.ts`,
            `import { api } from "${scope}/api-client";\nimport { useState } from "react";\n\nexport const useCart = () => {\n    const [count, setCount] = useState(0);\n    return { count, add: () => setCount(count + 1), checkout: () => api.post("/checkout", { count }) };\n};\n`,
        ],
        [
            `src/cart/useCart.test.ts`,
            `import { describe, expect, it } from "vitest";\n\ndescribe("cart", () => {\n    it("starts empty", () => expect(0).toBe(0));\n});\n`,
        ],
    ],
    api: (scope, app) => [
        [
            `package.json`,
            json({
                name: `${scope}/${app}`,
                private: true,
                type: `module`,
                intentic: { template: `api` },
                scripts: { dev: `tsx watch src/server.ts`, test: `vitest run` },
                dependencies: { hono: `^4.9.0`, "@hono/node-server": `^1.19.0`, zod: `^4.1.0` },
                devDependencies: { [`${scope}/config`]: `workspace:*`, tsx: `^4.20.0`, vitest: `^3.2.4` },
            }),
        ],
        [
            `src/server.ts`,
            `import { serve } from "@hono/node-server";\nimport { app } from "./app";\n\nserve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3000) });\n`,
        ],
        [
            `src/app.ts`,
            `import { Hono } from "hono";\nimport { checkout } from "./routes/checkout";\n\nexport const app = new Hono().get("/health", (c) => c.json({ ok: true })).route("/checkout", checkout);\n`,
        ],
        [`src/routes/checkout.ts`, `import { Hono } from "hono";\n\nexport const checkout = new Hono().post("/", (c) => c.json({ url: "https://checkout.stripe.com/c/pay/demo" }));\n`],
        [
            `src/app.test.ts`,
            `import { expect, it } from "vitest";\nimport { app } from "./app";\n\nit("answers its health check", async () => {\n    expect((await app.request("/health")).status).toBe(200);\n});\n`,
        ],
    ],
    site: (scope, app) => [
        [
            `package.json`,
            json({
                name: `${scope}/${app}`,
                private: true,
                type: `module`,
                intentic: { template: `site` },
                scripts: { dev: `astro dev --port $PORT --host`, build: `astro build` },
                dependencies: { astro: `^5.14.0`, [`${scope}/ui`]: `workspace:*` },
            }),
        ],
        [`astro.config.mjs`, `import { defineConfig } from "astro/config";\n\nexport default defineConfig({ site: "https://acme.shop" });\n`],
        [`src/pages/index.astro`, `---\nimport "${scope}/ui/styles.css";\n---\n<html lang="en"><body><h1>Acme Shop</h1><p>Hand-made goods, shipped across Europe.</p></body></html>\n`],
    ],
    worker: (scope, app) => [
        [
            `package.json`,
            json({
                name: `${scope}/${app}`,
                private: true,
                type: `module`,
                intentic: { template: `worker` },
                scripts: { dev: `tsx watch src/worker.ts`, test: `vitest run` },
                dependencies: { [`${scope}/api-client`]: `workspace:*`, bullmq: `^5.58.0` },
                devDependencies: { tsx: `^4.20.0`, vitest: `^3.2.4` },
            }),
        ],
        [
            `src/worker.ts`,
            `import { Worker } from "bullmq";\nimport { sendReceipt } from "./jobs/receipt";\n\nnew Worker("emails", sendReceipt, { connection: { url: process.env.REDIS_URL } });\n`,
        ],
        [`src/jobs/receipt.ts`, `import { api } from "${scope}/api-client";\n\nexport const sendReceipt = async (job: { data: { order: string } }) => api.post("/receipts", job.data);\n`],
        [`src/jobs/receipt.test.ts`, `import { expect, it } from "vitest";\n\nit("names the order it sends", () => expect("2318").toMatch(/\\d+/));\n`],
    ],
} satisfies Record<AppTemplate, (scope: string, app: string) => [string, string][]>;

/** One app's files, root-relative, as `intentic scaffold add-app` writes them under `<repo>/_apps/<app>/`. */
export const appFiles = (repo: string, template: AppTemplate, app: string): [string, string][] =>
    TEMPLATE_FILES[template](`@${repo}`, app).map(([path, body]) => [`${repo}/_apps/${app}/${path}`, body]);

// The shared packages: a UI kit with declared layers, the typed API client the apps call, and the tooling preset.
const packageFiles = (scope: string): [string, string][] => [
    [
        `packages/ui/package.json`,
        json({ name: `${scope}/ui`, private: true, type: `module`, exports: { ".": `./src/index.ts`, "./styles.css": `./src/styles.css` }, devDependencies: { [`${scope}/config`]: `workspace:*` } }),
    ],
    [
        `packages/ui/layers.json`,
        json({
            layers: [
                { name: `tokens`, about: `Colours, spacing and type as values.`, units: [`tokens`] },
                { name: `primitives`, about: `Buttons, fields and the page frame.`, units: [`primitives`] },
                { name: `patterns`, about: `Composed pieces: the cart drawer, the product card.`, units: [`patterns`] },
            ],
        }),
    ],
    [`packages/ui/src/index.ts`, `export { Button } from "./primitives/Button";\nexport { Page } from "./primitives/Page";\nexport { ProductCard } from "./patterns/ProductCard";\n`],
    [`packages/ui/src/styles.css`, `:root {\n    --accent: #c2410c;\n    --radius: 10px;\n}\n`],
    [`packages/ui/src/tokens/colors.ts`, `export const colors = { accent: "#c2410c", ink: "#1c1917", paper: "#fafaf9" } as const;\n`],
    [`packages/ui/src/tokens/space.ts`, `export const space = [0, 4, 8, 12, 16, 24, 32] as const;\n`],
    [
        `packages/ui/src/primitives/Button.tsx`,
        `import { colors } from "../tokens/colors";\nimport { space } from "../tokens/space";\n\nexport const Button = (props: { onClick?: () => void; children: unknown }) => (\n    <button style={{ background: colors.accent, padding: space[3] }} onClick={props.onClick}>{props.children}</button>\n);\n`,
    ],
    [`packages/ui/src/primitives/Page.tsx`, `import { colors } from "../tokens/colors";\n\nexport const Page = (props: { title: string; children: unknown }) => <main style={{ color: colors.ink }}>{props.children}</main>;\n`],
    [
        `packages/ui/src/patterns/ProductCard.tsx`,
        `import { Button } from "../primitives/Button";\nimport { space } from "../tokens/space";\n\nexport const ProductCard = (props: { name: string }) => <article style={{ gap: space[2] }}>{props.name}<Button>Add</Button></article>;\n`,
    ],
    [`packages/ui/src/primitives/Button.test.tsx`, `import { expect, it } from "vitest";\nimport { Button } from "./Button";\n\nit("is a component", () => expect(typeof Button).toBe("function"));\n`],
    [`packages/api-client/package.json`, json({ name: `${scope}/api-client`, private: true, type: `module`, exports: { ".": `./src/index.ts` }, dependencies: { zod: `^4.1.0` } })],
    [
        `packages/api-client/src/index.ts`,
        `import { request } from "./request";\n\nexport const api = { post: (path: string, body: unknown) => request("POST", path, body) };\n`,
    ],
    [
        `packages/api-client/src/request.ts`,
        `export const request = async (method: string, path: string, body: unknown) =>\n    (await fetch(\`/api\${path}\`, { method, body: JSON.stringify(body) })).json();\n`,
    ],
    [`packages/config/package.json`, json({ name: `${scope}/config`, private: true, type: `module`, exports: { "./vite": `./vite.ts` } })],
    [`packages/config/vite.ts`, `import react from "@vitejs/plugin-react";\n\nexport const viteConfig = () => ({ plugins: [react()] });\n`],
];

/** Every file of a freshly cloned `name`, root-relative: the workspace, its storefront and admin apps, an API. */
export const monorepoFiles = (name: string): [string, string][] => {
    const scope = `@${name}`;
    const root: [string, string][] = [
        [
            `README.md`,
            `# ${name}\n\nThe shop's apps and the packages they share, as one pnpm workspace.\n\n- \`_apps/storefront\`: what customers see.\n- \`_apps/admin\`: orders, refunds and stock.\n- \`_apps/api\`: the HTTP API both of them call.\n- \`packages/\`: the UI kit, the API client and the tooling preset.\n\n\`pnpm install\`, then \`pnpm -C _apps/storefront dev\`.\n`,
        ],
        [`package.json`, json({ name, private: true, packageManager: `pnpm@10.18.0`, scripts: { test: `pnpm -r test` } })],
        [`pnpm-workspace.yaml`, `packages:\n  - "_apps/*"\n  - "packages/*"\n`],
        [`.gitignore`, `node_modules\ndist\n.turbo\n`],
    ];
    return [
        ...root.map(([path, body]): [string, string] => [`${name}/${path}`, body]),
        ...packageFiles(scope).map(([path, body]): [string, string] => [`${name}/${path}`, body]),
        ...appFiles(name, `web`, `storefront`),
        ...appFiles(name, `web`, `admin`),
        ...appFiles(name, `api`, `api`),
    ];
};
