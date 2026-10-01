// A web page made into one sealed document: what it refuses (the policy, pinned directive by directive), which files
// beside it are carried in and from where, what is counted and left out, and how a link is handed to the window.
import "@intentic/testing/dom";
import { buildPreviewDocument, candidatePaths, MAX_FILE_BYTES, mimeOf, PREVIEW_POLICY, PreviewAskSchema, refKind } from "./htmlDocument";

// A workspace of text files, recording every read.
const workspaceOf = (files: Record<string, string | Blob>) => {
    const reads: string[] = [];
    const load = async (path: string): Promise<Blob | undefined> => {
        reads.push(path);
        const file = files[path];
        return file === undefined ? undefined : file instanceof Blob ? file : new Blob([file]);
    };
    return { load, reads };
};

const b64 = (text: string): string => btoa(text);

const parse = (html: string): Document => new DOMParser().parseFromString(html, `text/html`);

describe(`PREVIEW_POLICY`, () => {
    it(`refuses the network and every other origin, and lets in only what the document itself carries`, () => {
        const directives = Object.fromEntries(PREVIEW_POLICY.split(`; `).map((directive) => [directive.split(` `)[0], directive.split(` `).slice(1).join(` `)]));
        expect(directives).toEqual({
            "default-src": `'none'`,
            "script-src": `'unsafe-inline' 'unsafe-eval'`,
            "style-src": `'unsafe-inline'`,
            "img-src": `data: blob:`,
            "font-src": `data:`,
            "media-src": `data: blob:`,
            "connect-src": `'none'`,
            "frame-src": `'none'`,
            "worker-src": `'none'`,
            "object-src": `'none'`,
            "form-action": `'none'`,
            "base-uri": `'none'`,
            "manifest-src": `'none'`,
        });
    });
});

describe(`refKind`, () => {
    it(`tells a place in the page, carried bytes, the internet, another scheme and a workspace file apart`, () => {
        expect(
            [`#top`, `data:image/png;base64,AA`, `blob:x`, `https://cdn.example/a.js`, `//fonts.example/f.css`, `mailto:a@b.c`, `javascript:void 0`, ``, `img/a.png`, `/css/site.css`, `../up.css`].map(
                refKind,
            ),
        ).toEqual([`fragment`, `inline`, `inline`, `remote`, `remote`, `elsewhere`, `elsewhere`, `elsewhere`, `file`, `file`, `file`]);
    });
});

describe(`candidatePaths`, () => {
    it(`reads a relative reference from the page's folder, without its query or fragment, percent-escapes decoded`, () => {
        expect(candidatePaths(`site/pages/about.html`, `../img/My%20logo.png?v=3#x`)).toEqual([`site/img/My logo.png`]);
        expect(candidatePaths(`index.html`, `./style.css`)).toEqual([`style.css`]);
    });

    it(`tries a root-absolute reference from the page's folder and then each folder above it`, () => {
        expect(candidatePaths(`shop/pages/about.html`, `/css/site.css`)).toEqual([`shop/pages/css/site.css`, `shop/css/site.css`, `css/site.css`]);
    });

    it(`names nothing for a reference that climbs out of the workspace`, () => {
        expect(candidatePaths(`site/index.html`, `../../secret.css`)).toEqual([]);
    });
});

describe(`mimeOf`, () => {
    it(`labels what a browser refuses unlabelled, and falls back to bytes`, () => {
        expect([`a.SVG`, `f.woff2`, `x.js`, `y.unknown`].map(mimeOf)).toEqual([`image/svg+xml`, `font/woff2`, `text/javascript`, `application/octet-stream`]);
    });
});

describe(`buildPreviewDocument`, () => {
    it(`opens the head with the policy, before anything the page carries`, async () => {
        const built = await buildPreviewDocument(`<!doctype html><html><head><title>Q3</title></head><body>hi</body></html>`, `q3.html`, workspaceOf({}).load);
        const head = parse(built.html).head;
        expect([...head.children].map((element) => element.tagName.toLowerCase())).toEqual([`meta`, `meta`, `script`, `title`]);
        expect(head.children[0]?.getAttribute(`http-equiv`)).toBe(`Content-Security-Policy`);
        expect(head.children[0]?.getAttribute(`content`)).toBe(PREVIEW_POLICY);
        expect(built.html.startsWith(`<!DOCTYPE html><html>`)).toBe(true);
    });

    it(`carries a stylesheet in as a style, its imports inlined and its pictures and fonts read from the sheet's own folder`, async () => {
        const { load } = workspaceOf({
            "site/css/main.css": `@charset "utf-8"; @import "print.css" print; body { background: url('../img/bg.svg'); }`,
            "site/css/print.css": `@charset "utf-8"; @font-face { src: url(fonts/a.woff2); }`,
            "site/css/fonts/a.woff2": `WOFF`,
            "site/img/bg.svg": `<svg/>`,
        });
        const built = await buildPreviewDocument(`<link rel="stylesheet" href="css/main.css" media="screen"><p>x</p>`, `site/index.html`, load);
        const style = parse(built.html).querySelector(`style`);
        expect(style?.getAttribute(`media`)).toBe(`screen`);
        expect(style?.textContent).toBe(
            `@charset "utf-8"; @media print {\n @font-face { src: url("data:font/woff2;base64,${b64(`WOFF`)}"); }\n} ` +
                `body { background: url("data:image/svg+xml;base64,${b64(`<svg/>`)}"); }`,
        );
        expect(parse(built.html).querySelector(`link`)).toBeNull();
        // Read concurrently, so in no particular order.
        expect([...built.carried].sort()).toEqual([`site/css/fonts/a.woff2`, `site/css/main.css`, `site/css/print.css`, `site/img/bg.svg`]);
    });

    it(`carries pictures and a script in, and a script's text cannot close its element early`, async () => {
        const { load } = workspaceOf({
            "img/a.png": `PNG`,
            "img/b.png": `PNGB`,
            "app.js": `document.body.append("</script><b>")`,
        });
        const built = await buildPreviewDocument(
            `<body><img src="img/a.png"><picture><source srcset="img/b.png 2x, img/c.png 3x"></picture><script src="app.js" defer></script></body>`,
            `index.html`,
            load,
        );
        const doc = parse(built.html);
        expect(doc.querySelector(`img`)?.getAttribute(`src`)).toBe(`data:image/png;base64,${b64(`PNG`)}`);
        expect(doc.querySelector(`source`)?.getAttribute(`srcset`)).toBe(`data:image/png;base64,${b64(`PNGB`)}`);
        const script = doc.querySelectorAll(`script`)[1];
        expect(script?.hasAttribute(`src`)).toBe(false);
        expect(script?.textContent).toBe(`document.body.append("<\\/script><b>")`);
        expect(doc.querySelector(`b`)).toBeNull();
    });

    it(`counts what the page asks of the internet and leaves it for the policy to refuse`, async () => {
        const built = await buildPreviewDocument(
            `<script src="https://cdn.example/chart.js"></script><img src="//img.example/a.png"><style>@font-face { src: url(https://fonts.example/f.woff2) }</style>`,
            `page.html`,
            workspaceOf({}).load,
        );
        expect(built.remote).toBe(3);
        expect(parse(built.html).querySelectorAll(`script`)[1]?.getAttribute(`src`)).toBe(`https://cdn.example/chart.js`);
        expect(built.carried).toEqual([]);
    });

    it(`names the files it could not carry: one that is not there, and one too large to hold`, async () => {
        const { load } = workspaceOf({ "big.png": new Blob([new Uint8Array(MAX_FILE_BYTES + 1)]) });
        const built = await buildPreviewDocument(`<img src="gone.png">`, `docs/page.html`, load);
        expect(built.missing).toEqual([`docs/gone.png`]);
        const second = await buildPreviewDocument(`<img src="../big.png">`, `docs/page.html`, load);
        expect(second.missing).toEqual([`big.png`]);
        expect(parse(second.html).querySelector(`img`)?.getAttribute(`src`)).toBe(`../big.png`);
    });

    it(`reads a file named twice once`, async () => {
        const workspace = workspaceOf({ "a.png": `PNG` });
        await buildPreviewDocument(`<img src="a.png"><img src="./a.png"><div style="background: url(a.png)"></div>`, `index.html`, workspace.load);
        expect(workspace.reads).toEqual([`a.png`]);
    });

    it(`drops the page's own base and refresh, and marks a link to another workspace file for the window to open`, async () => {
        const built = await buildPreviewDocument(
            `<head><base href="https://elsewhere.example/"><meta http-equiv="Refresh" content="0; url=https://x.example"></head>` +
                `<body><a href="../about.html#team">About</a><a href="#top">Top</a><a href="https://example.com">Out</a></body>`,
            `site/pages/index.html`,
            workspaceOf({}).load,
        );
        const doc = parse(built.html);
        expect(doc.querySelector(`base`)).toBeNull();
        expect(doc.querySelector(`meta[http-equiv="Refresh"]`)).toBeNull();
        expect([...doc.querySelectorAll(`a`)].map((link) => link.getAttribute(`data-intentic-path`))).toEqual([`site/about.html`, null, null]);
    });

    it(`keeps a page with no doctype without one, so it renders as it would anywhere else`, async () => {
        const built = await buildPreviewDocument(`<p>quirks</p>`, `old.htm`, workspaceOf({}).load);
        expect(built.html.startsWith(`<html>`)).toBe(true);
    });
});

describe(`PreviewAskSchema`, () => {
    const ask = (data: unknown): { open: string } | { href: string } | { pointer: boolean } | undefined => {
        const parsed = PreviewAskSchema.safeParse(data);
        return parsed.success ? parsed.data.intenticHtmlPreview : undefined;
    };

    it(`lets a frame ask for a workspace file or an internet address, and nothing else`, () => {
        expect(ask({ intenticHtmlPreview: { open: `site/about.html` } })).toEqual({ open: `site/about.html` });
        expect(ask({ intenticHtmlPreview: { href: `https://example.com/a` } })).toEqual({ href: `https://example.com/a` });
    });

    it(`lets a frame tell whether a mouse is over it, as a yes or a no and nothing else`, () => {
        expect([true, false].map((pointer) => ask({ intenticHtmlPreview: { pointer } }))).toEqual([{ pointer: true }, { pointer: false }]);
        expect([`true`, 1, null].map((pointer) => ask({ intenticHtmlPreview: { pointer } }))).toEqual([undefined, undefined, undefined]);
    });

    it(`refuses a path out of the workspace or from its root, another scheme, and anything else a page could post`, () => {
        expect(
            [
                { intenticHtmlPreview: { open: `../../etc/passwd` } },
                { intenticHtmlPreview: { open: `/etc/passwd` } },
                { intenticHtmlPreview: { open: `` } },
                { intenticHtmlPreview: { href: `javascript:alert(1)` } },
                { intenticHtmlPreview: { href: `file:///etc/passwd` } },
                { open: `a.html` },
                `open a.html`,
                null,
            ].map(ask),
        ).toEqual([undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
    });
});
