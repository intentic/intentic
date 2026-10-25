import { z } from "zod";

// Inject into opaque-origin previews: in-memory storage/cookies, cancelled Vite preload errors and worker wrappers keep static pages working.
// Worker-relative imports/fetches resolve from the real script; external links open tabs and internal links stay framed.
// Report loaded/missing adjacent files for refresh/error UI; intenticPrint returns current DOM with absolute URLs and rasterized canvases.
// Keep allow-same-origin off so previews cannot reach editor/daemon storage or APIs.
export const PREVIEW_GUIDE_SCRIPT = `(() => {
    const say = (message) => parent.postMessage({ intenticHtmlPreview: message }, "*");
    const memory = () => {
        const held = new Map();
        return {
            get length() { return held.size; },
            key: (index) => [...held.keys()][index] ?? null,
            getItem: (key) => (held.has(String(key)) ? held.get(String(key)) : null),
            setItem: (key, value) => { held.set(String(key), String(value)); },
            removeItem: (key) => { held.delete(String(key)); },
            clear: () => { held.clear(); },
        };
    };
    for (const name of ["localStorage", "sessionStorage"]) {
        try { void window[name]; } catch { Object.defineProperty(window, name, { value: memory(), configurable: true }); }
    }
    try { void document.cookie; } catch {
        const jar = new Map();
        Object.defineProperty(document, "cookie", {
            configurable: true,
            get: () => [...jar].map(([name, value]) => name + "=" + value).join("; "),
            set: (text) => {
                const [pair, ...attributes] = String(text).split(";");
                const at = pair.indexOf("=");
                const name = (at < 0 ? "" : pair.slice(0, at)).trim();
                const value = (at < 0 ? pair : pair.slice(at + 1)).trim();
                const gone = attributes.some((attribute) => {
                    const [key, ...rest] = attribute.split("=");
                    const setting = rest.join("=").trim();
                    const lower = key.trim().toLowerCase();
                    return (lower === "max-age" && Number(setting) <= 0) || (lower === "expires" && Date.parse(setting) < Date.now());
                });
                if (gone) jar.delete(name); else jar.set(name, value);
            },
        });
    }
    addEventListener("vite:preloadError", (event) => event.preventDefault());
    const Native = window.Worker;
    if (typeof Native === "function") {
        window.Worker = function Worker(script, options) {
            const url = new URL(String(script), location.href);
            if (!/^https?:$/.test(url.protocol)) return new Native(script, options);
            const at = JSON.stringify(url.href);
            const fetches = "const get = self.fetch.bind(self); self.fetch = (input, init) => get(typeof input === 'string' ? new URL(input, " + at + ").href : input, init);";
            // Chromium starts no module worker from a blob an opaque origin made, but does from a data address; the
            // fetch fix is a module of its own so it runs before the worker's, as static imports run in order.
            if (options?.type === "module") {
                const data = (code) => "data:text/javascript," + encodeURIComponent(code);
                return new Native(data("import " + JSON.stringify(data(fetches)) + "; import " + at + ";"), options);
            }
            const body = fetches + "const load = self.importScripts.bind(self);" +
                "self.importScripts = (...urls) => load(...urls.map((each) => new URL(each, " + at + ").href)); load(" + at + ");";
            return new Native(URL.createObjectURL(new Blob([body], { type: "text/javascript" })), options);
        };
        window.Worker.prototype = Native.prototype;
    }
    const prefix = location.pathname.split("/").slice(0, 4).join("/") + "/";
    const own = (url) => {
        try {
            const parsed = new URL(url, location.href);
            return parsed.origin === location.origin && parsed.pathname.startsWith(prefix) ? decodeURIComponent(parsed.pathname.slice(prefix.length)) : undefined;
        // allow(silent-catch): an address that does not parse or decode is not one of the page's own files.
        } catch { return undefined; }
    };
    addEventListener("click", (event) => {
        const link = event.target instanceof Element ? event.target.closest("a[href], area[href]") : null;
        if (link === null || event.button !== 0 || event.defaultPrevented) return;
        const href = link.href;
        if (!/^https?:/i.test(href) || own(href) !== undefined) return;
        event.preventDefault();
        say({ href });
    });
    const told = new Set();
    const tell = (urls) => {
        const fresh = [];
        for (const url of urls) {
            const path = own(url);
            if (path !== undefined && !told.has(path)) { told.add(path); fresh.push(path); }
        }
        if (fresh.length > 0) say({ loaded: fresh });
    };
    tell([location.href]);
    new PerformanceObserver((list) => tell(list.getEntries().map((entry) => entry.name))).observe({ type: "resource", buffered: true });
    addEventListener("error", (event) => {
        const element = event.target;
        if (!(element instanceof Element)) return;
        const url = element.currentSrc || element.src || element.href;
        const path = typeof url === "string" ? own(url) : undefined;
        if (path !== undefined) say({ missing: path });
    }, true);
    let moved = 0;
    addEventListener("pointermove", (event) => {
        if (event.pointerType === "touch" || event.timeStamp - moved < 150) return;
        moved = event.timeStamp;
        say({ pointer: true });
    }, true);
    addEventListener("pointerout", (event) => {
        if (event.relatedTarget !== null || event.pointerType === "touch") return;
        moved = 0;
        say({ pointer: false });
    }, true);
    const snapshot = () => {
        const live = [...document.querySelectorAll("canvas")];
        const copy = document.documentElement.cloneNode(true);
        [...copy.querySelectorAll("canvas")].forEach((canvas, index) => {
            try {
                const picture = document.createElement("img");
                picture.src = live[index].toDataURL();
                picture.style.cssText = canvas.style.cssText;
                picture.width = live[index].clientWidth || live[index].width;
                canvas.replaceWith(picture);
            // allow(silent-catch): a canvas drawn from another origin cannot be read, and prints as the page left it.
            } catch {}
        });
        for (const element of copy.querySelectorAll("[src], [href], [poster]")) {
            for (const name of ["src", "href", "poster"]) {
                const value = element.getAttribute(name);
                if (value !== null && !/^(?:data|blob|javascript|mailto):/i.test(value) && URL.canParse(value, document.baseURI)) {
                    element.setAttribute(name, new URL(value, document.baseURI).href);
                }
            }
        }
        return copy.outerHTML;
    };
    addEventListener("message", (event) => {
        if (event.source === parent && event.data?.intenticPrint === true) parent.postMessage({ intenticPrintHtml: snapshot() }, "*");
    });
})();`;

// What a served page may tell the editor, parsed where it arrives since the page's own scripts can post anything: an
// internet address to open in a tab, whether a mouse is over it, the files it loaded from beside itself, or one that
// failed. Paths are relative to the folder the ticket serves (WorkspacePreviewTicketSchema `root`).
export const PreviewGuideSayingSchema = z.object({
    intenticHtmlPreview: z.union([
        z.object({ href: z.string().regex(/^https?:\/\//i) }),
        z.object({ pointer: z.boolean() }),
        z.object({ loaded: z.array(z.string()).max(1000) }),
        z.object({ missing: z.string() }),
    ]),
});
export type PreviewGuideSaying = z.infer<typeof PreviewGuideSayingSchema>["intenticHtmlPreview"];
