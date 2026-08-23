/* The CLI end to end against a loopback fixture site: fetch, cache, query filtering, crawl with robots
 * and caps, budget clipping — the whole surface an agent touches. Driven IN-PROCESS through the same
 * `run(app, …)` seam cli.ts calls, with stdout captured by a spy: no build artifact to depend on, and no
 * child process (some sandboxes give each process its own loopback, which would turn a spawn-based suite
 * into a hang that says nothing about webq). The browser fallback has its own gated test at the end. */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { run, type StricliProcess } from "@stricli/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { app } from "./app.js";
import { chromiumAvailable } from "./lib/browser.js";

const page = (title: string, body: string): string =>
    `<html><head><title>${title}</title></head><body>
    <nav><a href="/">Home</a><a href="/a">A</a></nav>
    <main><article>${body}</article></main>
    <footer><a href="/tos">Terms</a> Copyright</footer></body></html>`;

const paragraphs = (label: string): string =>
    Array.from(
        { length: 12 },
        (_, i) => `<p>${label} paragraph ${i} with plenty of dense readable words in a complete sentence about topics agents research.</p>`,
    ).join("");

let server: Server;
let base = "";
let home = "";

const routes = (): Record<string, { body: string; type?: string }> => ({
    "/": {
        body: page(
            "Home",
            `<h1>Docs home</h1>${paragraphs("home")}<p><a href="/a">Alpha guide</a> <a href="/sub/c">Webhooks retry reference</a> <a href="/blocked">Secret</a> <a href="https://offsite.example/x">Offsite</a> <a href="/gone">Gone</a></p>`,
        ),
    },
    "/a": { body: page("Alpha", `<h1>Alpha</h1>${paragraphs("alpha")}`) },
    "/sub/c": { body: page("Webhooks", `<h1>Webhook retries</h1><p>webhook retry policy with backoff.</p>${paragraphs("webhook retry")}`) },
    "/blocked": { body: page("Blocked", "<h1>Never fetched</h1>") },
    "/robots.txt": { body: "User-agent: *\nDisallow: /blocked\n", type: "text/plain" },
    "/plain.json": { body: JSON.stringify({ hello: "world" }), type: "application/json" },
});

beforeAll(async () => {
    server = createServer((req, res) => {
        const route = routes()[(req.url ?? "/").split("?")[0] ?? "/"];
        if (route === undefined) {
            res.writeHead(404, { "content-type": "text/html" });
            res.end("<html><body>nope</body></html>");
            return;
        }
        res.writeHead(200, { "content-type": route.type ?? "text/html; charset=utf-8" });
        res.end(route.body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    home = mkdtempSync(join(tmpdir(), "webq-test-"));
    process.env["WEBQ_HOME"] = home;
});

afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    delete process.env["WEBQ_HOME"];
    rmSync(home, { recursive: true, force: true });
});

/** Runs the CLI in-process; returns captured stdout and the exit code the process would have carried. */
const webq = async (...args: string[]): Promise<{ out: string; exit: number }> => {
    let out = "";
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
        out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
        return true;
    }) as typeof process.stdout.write);
    const previous = process.exitCode;
    process.exitCode = undefined;
    try {
        await run(app, args, { process: process as StricliProcess });
        return { out, exit: typeof process.exitCode === "number" ? process.exitCode : 0 };
    } finally {
        spy.mockRestore();
        process.exitCode = previous;
    }
};

describe("webq fetch", () => {
    it("prints a capsule, clips to the budget, and saves the whole page", async () => {
        const { out, exit } = await webq("fetch", `${base}/a`, "--budget", "60");
        expect(exit).toBe(0);
        expect(out).toContain("webq: Alpha");
        expect(out).toContain("· network");
        expect(out).toContain("[cut at 60 of");
        const path = /saved: (\S+)/.exec(out)?.[1] ?? "";
        const file = readFileSync(path, "utf8");
        expect(file).toContain(`url: ${base}/a`);
        expect(file).toContain("alpha paragraph 11");
    });

    it("serves the second fetch from cache", async () => {
        const { out } = await webq("fetch", `${base}/a`, "--budget", "0");
        expect(out).toContain("· cache");
    });

    it("bypasses the cache under --fresh", async () => {
        const { out } = await webq("fetch", `${base}/a`, "--budget", "0", "--fresh");
        expect(out).toContain("· network");
    });

    it("keeps only query-relevant blocks and says what it kept", async () => {
        const { out } = await webq("fetch", `${base}/sub/c`, "--query", "backoff policy", "--budget", "200", "--fresh");
        expect(out).toContain("webhook retry policy with backoff");
        expect(out).toMatch(/query (kept|matched)/);
    });

    it("fences non-HTML text content instead of parsing it", async () => {
        const { out } = await webq("fetch", `${base}/plain.json`, "--budget", "100");
        expect(out).toContain("```json");
        expect(out).toContain('"hello"');
    });

    it("exits 1 on an HTTP error page", async () => {
        const { exit } = await webq("fetch", `${base}/gone`, "--budget", "0");
        expect(exit).toBe(1);
    });

    it("emits machine-readable output under --json", async () => {
        const { out } = await webq("fetch", `${base}/a`, "--json");
        const parsed = JSON.parse(out) as { title: string; path: string; source: string };
        expect(parsed.title).toBe("Alpha");
        expect(parsed.path).toContain(home);
    });
});

describe("webq crawl", () => {
    it("crawls the site under its caps, obeying robots and staying on-origin", async () => {
        const outDir = join(home, "crawl-basic");
        const { out, exit } = await webq("crawl", `${base}/`, "--max-pages", "10", "--out", outDir, "--fresh");
        expect(exit).toBe(0);
        expect(out).toContain("3 pages");
        expect(out).toContain("robots 1");
        expect(out).toContain("offsite 1");
        // Two links lied: /gone from the home page and /tos from every footer.
        expect(out).toContain("http-errors 2");
        const files = readdirSync(outDir);
        expect(files).toContain("index.md");
        expect(files).toContain("index.json");
        expect(files.join(" ")).not.toContain("blocked");
        expect(readFileSync(join(outDir, "index.md"), "utf8")).toContain("| Alpha |");
    });

    it("visits query-relevant links first under a tight cap", async () => {
        const outDir = join(home, "crawl-query");
        const { out } = await webq("crawl", `${base}/`, "--query", "webhook retries", "--max-pages", "2", "--out", outDir, "--fresh");
        expect(out).toContain("2 pages");
        expect(out).toContain("/sub/c");
        expect(out).not.toContain(`${base}/a →`);
        expect(out).toContain("beyond-cap");
    });

    it("exits 1 when nothing could be crawled", async () => {
        const { exit } = await webq("crawl", `${base}/gone`, "--max-pages", "2", "--out", join(home, "crawl-empty"), "--fresh");
        expect(exit).toBe(1);
    });
});

describe("webq cache", () => {
    it("reports entries and clears them", async () => {
        const stats = await webq("cache");
        expect(stats.out).toMatch(/cache: \d+ entries/);
        const cleared = await webq("cache", "--clear");
        expect(cleared.out).toContain("cache cleared");
        const after = await webq("cache");
        expect(after.out).toContain("cache: 0 entries");
    });
});

const hasChromium = await chromiumAvailable();

describe("browser fallback", () => {
    it.skipIf(!hasChromium)("renders an app-shell page through Chromium", async () => {
        const shellServer = createServer((_req, res) => {
            res.writeHead(200, { "content-type": "text/html" });
            res.end(
                `<html><head><title>Shell</title></head><body><div id="root"></div><script>document.getElementById("root").innerHTML = "<h1>Hydrated</h1><p>Content that only exists after JavaScript ran in a real browser engine, long enough to clear the app-shell text threshold when rendered, with plenty of words to be sure the heuristic sees a real page.</p>";</script></body></html>`,
            );
        });
        await new Promise<void>((resolve) => shellServer.listen(0, "127.0.0.1", resolve));
        const shellBase = `http://127.0.0.1:${(shellServer.address() as AddressInfo).port}`;
        try {
            const { out } = await webq("fetch", `${shellBase}/`, "--budget", "100", "--fresh");
            expect(out).toContain("# Hydrated");
            expect(out).toContain("· browser");
        } finally {
            await new Promise((resolve) => shellServer.close(resolve));
        }
    });
});
