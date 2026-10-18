import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../app.js";
import { clientFor, errorCode, proven } from "../../harness/route-client.testing.js";
import { services } from "../../harness/route-services.testing.js";
import { workspacePaths } from "../workspace.js";
import { fakeFiles } from "../workspace-slice.testing.js";
import { statWorkspaceFileSize } from "./workspace-files.js";
import { PREVIEW_SANDBOX, rewriteRootAbsolute, servableSegments, siteRootOf } from "./workspace-preview.js";

// A previewed web page, driven over HTTP the way a frame loads it, against real files: the page and every file it names
// come back from addresses under the ticket, sandboxed into an opaque origin, and nothing the ticket should not reach is
// served at any spelling.

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>t</title>
<link rel="stylesheet" href="/assets/app.css"><script type="module" src="/assets/app.js"></script></head>
<body><img srcset="/assets/a.png 1x, /assets/b.png 2x" src="pic.png"><a href="other.html">next</a></body></html>`;

const withTree = async (run: (root: string) => Promise<void>): Promise<void> => {
    const root = await mkdtemp(join(tmpdir(), "preview-"));
    try {
        await mkdir(join(root, ".git"), { recursive: true });
        await writeFile(join(root, ".git/config"), "[core]\n");
        await writeFile(join(root, ".env"), "TOKEN=secret\n");
        await writeFile(join(root, "notes.md"), "# notes\n");
        await mkdir(join(root, "site/assets"), { recursive: true });
        await mkdir(join(root, "site/sub"), { recursive: true });
        await writeFile(join(root, "site/index.html"), PAGE);
        await writeFile(join(root, "site/other.html"), "<p>other</p>");
        await writeFile(join(root, "site/.secret"), "hidden");
        await writeFile(join(root, "site/data.json"), `{"a":1}`);
        await writeFile(join(root, "site/assets/app.css"), "body{background:url(/assets/bg.png)}");
        await writeFile(join(root, "site/assets/app.js"), `import "./dep.js";`);
        await writeFile(join(root, "site/assets/dep.js"), "export {};");
        await writeFile(join(root, "site/assets/a.png"), Buffer.alloc(64, 1));
        await writeFile(join(root, "site/clip.mp4"), Buffer.alloc(1000, 2));
        await writeFile(join(root, "site/sub/index.html"), "<p>sub</p>");
        await mkdir(join(root, "nested/.git"), { recursive: true });
        await writeFile(join(root, "nested/code.txt"), "another project");
        await writeFile(join(root, "nested/page.html"), "<p>nested</p>");
        await run(root);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
};

const appOver = (root: string) =>
    createApp(
        services({
            workspace: workspacePaths(root),
            files: fakeFiles({ size: statWorkspaceFileSize }),
            auth: { authorize: async () => proven("o@x.com", "owner"), authorizeOwner: async () => {} },
        }),
    );

// The ticket's own prefix, read off the page address the mint answered with.
const prefixOf = (page: string): string => page.split("/").slice(0, 4).join("/");

test("the page comes back sandboxed into an opaque origin, framable, its root-absolute addresses under the ticket", async () => {
    await withTree(async (root) => {
        const app = appOver(root);
        const minted = await clientFor(app).workspace.previewTicket({ path: "site/index.html" });
        expect(minted.root).toBe("");
        expect(minted.page).toMatch(/^\/workspace\/preview\/[\w-]+\/site\/index\.html$/);
        const prefix = prefixOf(minted.page);
        const response = await app.request(minted.page);
        expect(response.status).toBe(200);
        const policy = response.headers.get("content-security-policy") ?? "";
        expect(policy).toContain(PREVIEW_SANDBOX);
        expect(policy).not.toContain("allow-same-origin");
        expect(response.headers.get("access-control-allow-origin")).toBe("*");
        // Framed from the editor's origin, and openable in a tab: neither header may stand in the way.
        expect(response.headers.get("x-frame-options")).toBeNull();
        expect(response.headers.get("cross-origin-opener-policy")).toBeNull();
        expect(response.headers.get("content-type")).toBe("text/html");
        const html = await response.text();
        // The guide comes right after the declared charset, and the import map with it.
        expect(html.indexOf("intenticHtmlPreview")).toBeGreaterThan(html.indexOf(`<meta charset="utf-8">`));
        expect(html).toContain(`<script type="importmap">{"imports":{"/":"${prefix}/site/","${prefix}/":"${prefix}/"}}</script>`);
        expect(html).toContain(`href="${prefix}/site/assets/app.css"`);
        expect(html).toContain(`src="${prefix}/site/assets/app.js"`);
        expect(html).toContain(`srcset="${prefix}/site/assets/a.png 1x, ${prefix}/site/assets/b.png 2x"`);
        // Relative addresses already carry the ticket.
        expect(html).toContain(`src="pic.png"`);
        expect(html).toContain(`href="other.html"`);
    });
});

test("the files beside it are served typed, stylesheets rewritten, media ranged", async () => {
    await withTree(async (root) => {
        const app = appOver(root);
        const prefix = prefixOf((await clientFor(app).workspace.previewTicket({ path: "site/index.html" })).page);
        const css = await app.request(`${prefix}/site/assets/app.css`);
        expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
        expect(await css.text()).toBe(`body{background:url(${prefix}/site/assets/bg.png)}`);
        const script = await app.request(`${prefix}/site/assets/app.js`);
        expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
        expect(await script.text()).toBe(`import "./dep.js";`);
        const data = await app.request(`${prefix}/site/data.json`);
        expect(await data.json()).toEqual({ a: 1 });
        // A folder is its index page, at an address ending in a slash.
        const folder = await app.request(`${prefix}/site/sub`);
        expect(folder.status).toBe(301);
        expect(folder.headers.get("location")).toBe(`${prefix}/site/sub/`);
        expect(await (await app.request(`${prefix}/site/sub/`)).text()).toContain("<p>sub</p>");
        const clip = await app.request(`${prefix}/site/clip.mp4`, { headers: { range: "bytes=10-19" } });
        expect(clip.status).toBe(206);
        expect(clip.headers.get("content-range")).toBe("bytes 10-19/1000");
        expect((await clip.arrayBuffer()).byteLength).toBe(10);
        // Revalidated, never served blind.
        const tag = data.headers.get("etag") ?? "";
        expect((await app.request(`${prefix}/site/data.json`, { headers: { "if-none-match": tag } })).status).toBe(304);
    });
});

test("nothing outside the page's repository, hidden, or past the control plane is served at any spelling", async () => {
    await withTree(async (root) => {
        const app = appOver(root);
        const prefix = prefixOf((await clientFor(app).workspace.previewTicket({ path: "site/index.html" })).page);
        expect((await app.request(`${prefix}/notes.md`)).status).toBe(200);
        for (const path of [
            ".env",
            ".git/config",
            "site/.secret",
            "%2eenv",
            "site/%2e%2e/.env",
            "nested/code.txt",
            "nested/page.html",
            "site%2F..%2F.env",
        ]) {
            expect([path, (await app.request(`${prefix}/${path}`)).status]).toEqual([path, 404]);
        }
        // A link out of the served folder leads nowhere, however it is named inside it.
        const outside = await mkdtemp(join(tmpdir(), "outside-"));
        try {
            await writeFile(join(outside, "secret"), "nope");
            await symlink(join(outside, "secret"), join(root, "site/leak"));
            expect((await app.request(`${prefix}/site/leak`)).status).toBe(404);
        } finally {
            await rm(outside, { recursive: true, force: true });
        }
    });
});

test("a page in a repository of its own is served from that repository alone", async () => {
    await withTree(async (root) => {
        const app = appOver(root);
        const minted = await clientFor(app).workspace.previewTicket({ path: "nested/page.html" });
        expect(minted.root).toBe("nested");
        const prefix = prefixOf(minted.page);
        expect(minted.page).toBe(`${prefix}/page.html`);
        expect(await (await app.request(`${prefix}/code.txt`)).text()).toBe("another project");
        expect((await app.request(`${prefix}/../notes.md`)).status).not.toBe(200);
    });
});

test("unsaved text is served in place of the file, and the ticket is the only way in", async () => {
    await withTree(async (root) => {
        const app = appOver(root);
        const minted = await clientFor(app).workspace.previewTicket({ path: "site/other.html", source: "<p>edited</p>" });
        const text = await (await app.request(minted.page)).text();
        expect(text).toContain("<p>edited</p>");
        expect(text).toContain("intenticHtmlPreview");
        expect((await app.request("/workspace/preview/forged/site/index.html")).status).toBe(401);
        // A media ticket names one file, not a folder to serve: it buys no preview.
        const media = await clientFor(app).workspace.mediaTicket({ path: "notes.md" });
        expect((await app.request(`/workspace/preview/${media.ticket}/notes.md`)).status).toBe(401);
        // And a preview ticket buys no download.
        expect((await app.request(`/workspace/download?ticket=${prefixOf(minted.page).split("/")[3]}`)).status).toBe(401);
        expect(await errorCode(clientFor(app).workspace.previewTicket({ path: "missing.html" }))).toBe("NOT_FOUND");
        expect(await errorCode(clientFor(app).workspace.previewTicket({ path: ".intentic/x.html" }))).not.toBeUndefined();
    });
});

test("a site's root is the folder its root-absolute addresses exist under, nearest first", async () => {
    await withTree(async (root) => {
        expect(await siteRootOf(PAGE, join(root, "site"), root)).toBe("site");
        expect(await siteRootOf(`<img src="/site/assets/a.png">`, join(root, "site/sub"), root)).toBe("");
        expect(await siteRootOf(`<p>no addresses</p>`, join(root, "site/sub"), root)).toBe("site/sub");
    });
});

test("only the segments on the way to the page may be hidden", () => {
    expect(servableSegments(["site", "a.js"], ["site", "index.html"])).toBe(true);
    expect(servableSegments([".vitepress", "dist", "x.js"], [".vitepress", "dist", "index.html"])).toBe(true);
    expect(servableSegments([".env"], ["index.html"])).toBe(false);
    expect(servableSegments(["site", ".."], ["site", "index.html"])).toBe(false);
    expect(servableSegments([".git", "config"], [".git", "index.html"])).toBe(false);
});

test("rewriting leaves protocol-relative and relative addresses alone", () => {
    expect(rewriteRootAbsolute(`<script src="//cdn.example/x.js"></script><a href=/home>h</a><img src="a.png">`, "/p/T/")).toBe(
        `<script src="//cdn.example/x.js"></script><a href=/p/T/home>h</a><img src="a.png">`,
    );
});
