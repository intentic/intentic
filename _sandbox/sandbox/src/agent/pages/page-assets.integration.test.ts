import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { carryPage, PAGE_CDN_HOSTS } from "./page-assets.js";

// A one-pixel PNG, and the same bytes under a picture's name that are not a picture.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

describe("carryPage", () => {
    let root: string;
    let outside: string;
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "page-assets-"));
        outside = mkdtempSync(join(tmpdir(), "page-outside-"));
        mkdirSync(join(root, "site", "css"), { recursive: true });
        writeFileSync(join(root, "site", "dot.png"), PNG);
        writeFileSync(join(root, "site", "fake.png"), "not a picture");
        writeFileSync(join(root, "site", "css", "a.css"), "@import 'b.css'; .x{background:url(../dot.png)}");
        writeFileSync(join(root, "site", "css", "b.css"), ".y{color:red}");
        writeFileSync(join(root, "site", "app.js"), "console.log('</script>')");
        writeFileSync(join(outside, "secret.png"), PNG);
        symlinkSync(join(outside, "secret.png"), join(root, "site", "linked.png"));
    });
    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
    });

    const context = () => ({ baseDir: join(root, "site"), roots: [root] });

    it("carries pictures, stylesheets with their imports and urls, and scripts in from disk", async () => {
        const html =
            `<html><head><link rel="stylesheet" href="css/a.css"><script src="app.js"></script></head>` +
            `<body><img src="dot.png"><div style="background:url('dot.png')"></div><script>const shots=["${join(root, "site", "dot.png")}"]</script></body></html>`;
        const carried = await carryPage(html, context());
        expect(carried.html).not.toContain(`href="css/a.css"`);
        expect(carried.html).toContain(".y{color:red}");
        expect(carried.html).toContain(`url("data:image/png;base64,`);
        expect(carried.html).toContain(`<img src="data:image/png;base64,`);
        expect(carried.html).toContain(`const shots=["data:image/png;base64,`);
        // The carried script cannot end its own element early.
        expect(carried.html).toContain(`console.log('<\\/script>')`);
        expect(carried.missing).toEqual([]);
        expect(carried.files.toSorted()).toEqual([join(root, "site", "app.js"), join(root, "site", "css", "a.css"), join(root, "site", "css", "b.css"), join(root, "site", "dot.png")]);
    });

    it("leaves out a file that is not what its name says, or that a link takes outside the allowed folders", async () => {
        const carried = await carryPage(`<img src="fake.png"><img src="linked.png"><img src="gone.png">`, context());
        expect(carried.html).toBe(`<img src="fake.png"><img src="linked.png"><img src="gone.png">`);
        expect(carried.missing.toSorted()).toEqual(["fake.png", "gone.png", "linked.png"]);
    });

    it("fetches from a library CDN only, and names everything else it left out", async () => {
        const fetched: string[] = [];
        const fakeFetch = (async (url: string) => {
            fetched.push(url);
            return new Response("window.lib = 1;", { status: 200 });
        }) as unknown as typeof fetch;
        const html = `<script src="https://cdn.jsdelivr.net/npm/lib@1/lib.min.js"></script><script src="https://evil.example.com/x.js"></script><img src="http://cdn.jsdelivr.net/a.png">`;
        const carried = await carryPage(html, { ...context(), fetch: fakeFetch });
        expect(PAGE_CDN_HOSTS.has("cdn.jsdelivr.net")).toBe(true);
        expect(fetched).toEqual(["https://cdn.jsdelivr.net/npm/lib@1/lib.min.js"]);
        expect(carried.html).toContain("<script>window.lib = 1;</script>");
        expect(carried.fetched).toEqual(["https://cdn.jsdelivr.net/npm/lib@1/lib.min.js"]);
        expect(carried.leftOut.toSorted()).toEqual(["http://cdn.jsdelivr.net/a.png", "https://evil.example.com/x.js"]);
    });

    it("drops hints that point at the network, which the frame will never reach", async () => {
        const carried = await carryPage(`<link rel="preconnect" href="https://fonts.gstatic.com"><p>x</p>`, context());
        expect(carried.html).toBe(`<p>x</p>`);
    });
});
