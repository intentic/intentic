import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { downloadAsset } from "./release.js";

// A release binary arrives by the .gz copy beside it where the release has one, unpacked to the binary itself, and by
// the binary where it has none (every release from before the copies). Served from a local stand-in for GitHub.

const binary = Buffer.from(Array.from({ length: 200_000 }, (_, index) => index % 251));
const served: string[] = [];
let server: Server;
let base = "";

beforeAll(async () => {
    server = createServer((request, response) => {
        served.push(request.url ?? "");
        const body =
            request.url === "/new/agent.gz" ? gzipSync(binary) : request.url === "/new/agent" || request.url === "/old/agent" ? binary : undefined;
        if (body === undefined) {
            response.writeHead(404).end();
            return;
        }
        const range = /^bytes=(\d+)-$/u.exec(request.headers.range ?? "");
        const from = range === null ? 0 : Number(range[1]);
        response.writeHead(range === null ? 200 : 206, { "content-length": String(body.length - from) }).end(body.subarray(from));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    // SAFETY: a server listening on a TCP port reports an AddressInfo.
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});
afterAll(() => {
    server.close();
});

test("a release with .gz copies is downloaded by the copy and unpacked to the binary, leaving no copy behind", async () => {
    const dest = join(await mkdtemp(join(tmpdir(), "asset-")), "agent");
    served.length = 0;
    await downloadAsset(`${base}/new/agent`, dest);
    expect((await readFile(dest)).equals(binary)).toBe(true);
    expect(existsSync(`${dest}.gz`)).toBe(false);
    expect(served).toEqual(["/new/agent.gz"]);
});

test("a release from before the copies answers 404 for the .gz, and the binary itself is downloaded", async () => {
    const dest = join(await mkdtemp(join(tmpdir(), "asset-")), "agent");
    served.length = 0;
    await downloadAsset(`${base}/old/agent`, dest);
    expect((await readFile(dest)).equals(binary)).toBe(true);
    expect(served).toEqual(["/old/agent.gz", "/old/agent"]);
});

test("a cut-short copy is resumed where it stopped", async () => {
    const dest = join(await mkdtemp(join(tmpdir(), "asset-")), "agent");
    const packed = gzipSync(binary);
    await writeFile(`${dest}.gz`, packed.subarray(0, 100));
    await downloadAsset(`${base}/new/agent`, dest, { resume: true });
    expect((await readFile(dest)).equals(binary)).toBe(true);
});
