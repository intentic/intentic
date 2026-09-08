import http from "node:http";
import { mkdtemp, readdir, readlink, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { createPublicHandler } from "./public-serve.js";

// The outbox over real HTTP: the actual headers a stranger's browser gets, plus conditional requests (no stale cache)
// and ranges (a recording can seek).

const servers: http.Server[] = [];
afterAll(async () => {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
});

const servedRoot = async (files: Record<string, string>): Promise<{ port: number; root: string }> => {
    const root = await mkdtemp(join(tmpdir(), "outbox-http-"));
    for (const [name, content] of Object.entries(files)) {
        await writeFile(join(root, name), content);
    }
    const handler = createPublicHandler(root);
    const server = http.createServer((req, res) => void handler(req, res));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { port: (server.address() as AddressInfo).port, root };
};

const serve = async (files: Record<string, string>): Promise<number> => (await servedRoot(files)).port;

const request = (
    port: number,
    path: string,
    options: { method?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> =>
    new Promise((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port, path, method: options.method ?? "GET", headers: options.headers }, (response) => {
            let body = "";
            response.on("data", (chunk: Buffer) => {
                body += chunk.toString();
            });
            response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
        });
        req.on("error", reject);
        req.end();
    });

test("a published file is served with its type, nosniff, and noindex", async () => {
    const port = await serve({ "note.txt": "hello" });
    const response = await request(port, "/note.txt");
    expect(response.status).toBe(200);
    expect(response.body).toBe("hello");
    expect(response.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    // The hostname is unguessable, but a shared link can still leak; noindex keeps it out of search anyway.
    expect(response.headers["x-robots-tag"]).toBe("noindex");
});

test("an unknown type downloads instead of rendering", async () => {
    const port = await serve({ "bundle.tar.zst": "binary" });
    const response = await request(port, "/bundle.tar.zst");
    expect(response.headers["content-disposition"]).toBe("attachment");
});

// An SVG can carry script; publishing a diagram shouldn't also publish an execution context.
test("an SVG is served under a CSP that leaves presentation and takes scripting", async () => {
    const port = await serve({ "diagram.svg": `<svg xmlns="http://www.w3.org/2000/svg"/>` });
    const response = await request(port, "/diagram.svg");
    expect(response.headers["content-type"]).toBe("image/svg+xml");
    expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
});

test("a matching If-None-Match is a 304 with no body", async () => {
    const port = await serve({ "note.txt": "hello" });
    const first = await request(port, "/note.txt");
    const etag = String(first.headers.etag);
    const second = await request(port, "/note.txt", { headers: { "if-none-match": etag } });
    expect(second.status).toBe(304);
    expect(second.body).toBe("");
});

test("HEAD reports the length and sends nothing", async () => {
    const port = await serve({ "note.txt": "hello" });
    const response = await request(port, "/note.txt", { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers["content-length"]).toBe("5");
    expect(response.body).toBe("");
});

test("a byte range is a 206 with the requested slice and a content-range", async () => {
    const port = await serve({ "clip.txt": "0123456789" });
    const response = await request(port, "/clip.txt", { headers: { range: "bytes=2-5" } });
    expect(response.status).toBe(206);
    expect(response.body).toBe("2345");
    expect(response.headers["content-range"]).toBe("bytes 2-5/10");
});

// `bytes=-3` means the last three bytes, the one part of the grammar that reads backwards.
test("a suffix range returns the tail, not the head", async () => {
    const port = await serve({ "clip.txt": "0123456789" });
    const response = await request(port, "/clip.txt", { headers: { range: "bytes=-3" } });
    expect(response.status).toBe(206);
    expect(response.body).toBe("789");
});

test("an unsatisfiable or malformed range falls back to the whole file", async () => {
    const port = await serve({ "clip.txt": "0123456789" });
    expect((await request(port, "/clip.txt", { headers: { range: "bytes=99-200" } })).body).toBe("0123456789");
    expect((await request(port, "/clip.txt", { headers: { range: "lines=1-2" } })).body).toBe("0123456789");
});

test("the outbox is read-only from the internet", async () => {
    const port = await serve({ "note.txt": "hello" });
    const response = await request(port, "/note.txt", { method: "DELETE" });
    expect(response.status).toBe(405);
    expect(response.headers.allow).toBe("GET, HEAD");
});

// `pipe` only wires the destination, leaving the read descriptor open on abort; on this no-auth, 512 MB route anyone
// can exhaust the file table by looping aborts. `pipeline` destroys both ends.
test("an aborted download does not leave the read descriptor open", async () => {
    const { port, root } = await servedRoot({ "big.bin": "x".repeat(16 * 1024 * 1024) });
    const published = join(root, "big.bin");
    // Counts fds for this file only; a process-wide count would be racy with vitest's other open files.
    const openHandles = async (): Promise<number> => {
        const fds = await readdir(`/proc/${process.pid}/fd`).catch(() => [] as string[]);
        const targets = await Promise.all(fds.map((fd) => readlink(`/proc/${process.pid}/fd/${fd}`).catch(() => "")));
        return targets.filter((target) => target === published).length;
    };
    expect(await openHandles()).toBe(0);
    for (let i = 0; i < 20; i++) {
        await new Promise<void>((done) => {
            const req = http.get({ host: "127.0.0.1", port, path: "/big.bin" }, (response) => {
                // Abort on the first frame, so the stream is live rather than already drained.
                response.once("data", () => {
                    req.destroy();
                    done();
                });
            });
            req.on("error", () => done());
        });
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    // With `pipe`, this was twenty: one abandoned read per aborted request, closed by nothing.
    expect(await openHandles()).toBe(0);
});

// Every miss looks identical from outside; nothing here lets the outbox be probed for what it holds.
test("a blocked file and a missing one are the same 404 page", async () => {
    const port = await serve({ ".env": "TOKEN=abc" });
    const blocked = await request(port, "/.env");
    const missing = await request(port, "/nothing-here.txt");
    expect(blocked.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(blocked.body).toBe(missing.body);
    expect(blocked.body).toContain("Intentic");
});
