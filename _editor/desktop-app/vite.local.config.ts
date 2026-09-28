import { createHash } from "node:crypto";
import { join } from "node:path";
import { packageRoot, repoRoot } from "@intentic/constants/node";
import { defineConfig, type Plugin } from "vite";
import { shared } from "../web/vite.shared.ts";

// The local face: the editor built from the same source as the app (../web/vite.shared.ts), entered through
// local/main.ts, for the windows that show a folder of the user's own disk. It lands beside the launcher in the app's
// bundle as `dist/files/`, so a window opens it at `files/local`, which the app's asset protocol answers with
// `files/local.html`. `vite build` of the launcher empties `dist`, so this build runs after it (package.json).

const fromRoot = (path: string): string => join(repoRoot(import.meta.url), path);
const here = (path: string): string => join(packageRoot(import.meta.url), path);

// Every document request answers with the one page, as the app's asset protocol does in a built app.
const onePage = (): Plugin => ({
    name: `local-face-one-page`,
    configureServer: (server) => {
        const entry = `${server.config.base}local.html`;
        server.middlewares.use((request, _response, next) => {
            if (request.method === `GET` && request.headers.accept?.includes(`text/html`) === true) {
                request.url = entry;
            }
            next();
        });
    },
});

// WHAT MAY RUN IN A WINDOW ON A FOLDER. It shows whatever the folder holds (a stranger's markdown, a document from a
// mail), so its page says what it trusts: its own bundle, the inline scripts it was built with (by hash, so an injected
// one is not among them), the app's file server on loopback for data, documents and the office editor's frame, and
// images from the web as any markdown preview shows them. No script, frame or fetch from anywhere else; no eval.
// Built pages only: the dev server's client is itself scripts and a socket this would refuse.
const LOOPBACK = `http://127.0.0.1:*`;
const POLICY: Readonly<Record<string, readonly string[]>> = {
    "default-src": [`'self'`],
    "connect-src": [`'self'`, LOOPBACK],
    "img-src": [`'self'`, `data:`, `blob:`, LOOPBACK, `https:`],
    "media-src": [`'self'`, `data:`, `blob:`, LOOPBACK],
    "font-src": [`'self'`, `data:`],
    "style-src": [`'self'`, `'unsafe-inline'`],
    // The office editor, and a PDF in the browser's own viewer (the viewers extension's PdfViewer is an <object>).
    "frame-src": [`'self'`, `blob:`, LOOPBACK],
    "object-src": [`'self'`, `blob:`, LOOPBACK],
    "worker-src": [`'self'`, `blob:`],
    "base-uri": [`'self'`],
    "form-action": [`'none'`],
};

const INLINE_SCRIPT = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g;

const contentPolicy = (): Plugin => ({
    name: `local-face-content-policy`,
    apply: `build`,
    transformIndexHtml: {
        order: `post`,
        handler: (html) => {
            const inline = [...html.matchAll(INLINE_SCRIPT)].map(([, body = ``]) => `'sha256-${createHash(`sha256`).update(body).digest(`base64`)}'`);
            // WebAssembly compiles under 'wasm-unsafe-eval' (the syntax highlighter's engine), which is not eval.
            const directives = { ...POLICY, "script-src": [`'self'`, `'wasm-unsafe-eval'`, ...inline] };
            const content = Object.entries(directives)
                .map(([directive, sources]) => `${directive} ${sources.join(` `)}`)
                .join(`; `);
            // First in <head>: a policy governs only what the parser meets after it.
            return { html, tags: [{ tag: `meta`, attrs: { "http-equiv": `Content-Security-Policy`, content }, injectTo: `head-prepend` }] };
        },
    },
});

export default defineConfig({
    ...shared,
    plugins: [...shared.plugins, onePage(), contentPolicy()],
    resolve: {
        alias: {
            ...shared.resolve.alias,
            // The editor's entry and the one module of it the bootstrap reads, source-first.
            "@intentic/web/main": fromRoot(`_editor/web/src/main.ts`),
            "@intentic/web/local": fromRoot(`_editor/web/src/app/environments/local.ts`),
        },
    },
    base: `/files/`,
    // The editor's own public dir (fonts, icons, the extension shims).
    publicDir: fromRoot(`_editor/web/public`),
    // Proxied by the launcher's dev server (vite.config.ts), so `tauri dev` opens it at the launcher's address.
    server: { host: `127.0.0.1`, port: 47147, strictPort: true },
    build: {
        outDir: here(`dist/files`),
        emptyOutDir: true,
        target: `es2024`,
        // As the app's own build: no preload wait on the whole route graph, one stylesheet.
        modulePreload: false,
        cssCodeSplit: false,
        rolldownOptions: { input: { local: here(`local.html`) } },
    },
});
