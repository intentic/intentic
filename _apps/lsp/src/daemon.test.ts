import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Daemon } from "./daemon.js";
import type { Request, Response } from "./protocol.js";

const scaffold = async (files: Record<string, string>): Promise<string> => {
    const dir = mkdtempSync(join(tmpdir(), "lsp-daemon-"));
    await writeFile(join(dir, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(
        join(dir, "tsconfig.json"),
        JSON.stringify({
            compilerOptions: { module: "nodenext", moduleResolution: "nodenext", strict: true, noEmit: true, types: [] },
            include: ["*.ts"],
        }),
    );
    for (const [name, content] of Object.entries(files)) {
        await writeFile(join(dir, name), content);
    }
    return dir;
};

// One request over a real socket, so the framing is under test and not just the handler.
const request = (path: string, body: Request): Promise<Response> =>
    new Promise((resolve, reject) => {
        const socket = connect(path, () => socket.write(`${JSON.stringify(body)}\n`));
        let buffer = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => {
            buffer += chunk;
            const newline = buffer.indexOf("\n");
            if (newline !== -1) {
                socket.end();
                resolve(JSON.parse(buffer.slice(0, newline)) as Response);
            }
        });
        socket.once("error", reject);
    });

test("a diag request answers over the socket", async () => {
    const dir = await scaffold({ "bad.ts": "export const n: number = 'no';\n" });
    const daemon = new Daemon({ root: dir });
    const path = await daemon.listen();
    try {
        const response = await request(path, { verb: "diag", files: [join(dir, "bad.ts")] });
        expect(response.ok).toBe(true);
        expect("diagnostics" in response && response.diagnostics.map((d) => d.code)).toContain(2322);
    } finally {
        await daemon.close();
    }
});

test("touched files are re-read before the answer", async () => {
    const dir = await scaffold({ "a.ts": "export const n: number = 1;\n" });
    const file = join(dir, "a.ts");
    const daemon = new Daemon({ root: dir });
    const path = await daemon.listen();
    try {
        const clean = await request(path, { verb: "diag", files: [file] });
        expect("diagnostics" in clean && clean.diagnostics).toEqual([]);

        await writeFile(file, "export const n: number = 'no';\n");
        const stale = await request(path, { verb: "diag", files: [file] });
        expect("diagnostics" in stale && stale.diagnostics).toEqual([]);

        const rechecked = await request(path, { verb: "diag", files: [file], touched: [file] });
        expect("diagnostics" in rechecked && rechecked.diagnostics.map((d) => d.code)).toContain(2322);
    } finally {
        await daemon.close();
    }
});

test("the second identical question is served from the marker store", async () => {
    const dir = await scaffold({ "a.ts": "export const n: number = 'no';\n" });
    const file = join(dir, "a.ts");
    const daemon = new Daemon({ root: dir });
    const path = await daemon.listen();
    try {
        const first = await request(path, { verb: "diag", files: [file] });
        const second = await request(path, { verb: "diag", files: [file] });
        expect(second).toEqual(first);
    } finally {
        await daemon.close();
    }
});

test("a malformed line is answered with an error rather than killing the daemon", async () => {
    const dir = await scaffold({ "a.ts": "export const n: number = 1;\n" });
    const daemon = new Daemon({ root: dir });
    const path = await daemon.listen();
    try {
        const socket = connect(path);
        const broken = await new Promise<Response>((resolve) => {
            socket.setEncoding("utf8");
            socket.on("data", (chunk: string) => resolve(JSON.parse(chunk.trim()) as Response));
            socket.on("connect", () => socket.write("not json\n"));
        });
        expect(broken.ok).toBe(false);
        socket.end();
        // Still serving.
        expect((await request(path, { verb: "ping" })).ok).toBe(true);
    } finally {
        await daemon.close();
    }
});

test("the debounced refresh brings the open set current without being asked", async () => {
    const dir = await scaffold({ "a.ts": "export const n: number = 1;\n" });
    const file = join(dir, "a.ts");
    const daemon = new Daemon({ root: dir, refreshDebounceMs: 10 });
    const path = await daemon.listen();
    try {
        await request(path, { verb: "diag", files: [file] });
        await writeFile(file, "export const n: number = 'no';\n");
        // Announce the change but ask about nothing; the refresh is what should pick it up.
        await request(path, { verb: "diag", files: [], touched: [file] });
        await new Promise((resolve) => setTimeout(resolve, 100));
        const answer = await request(path, { verb: "diag", files: [file] });
        expect("diagnostics" in answer && answer.diagnostics.map((d) => d.code)).toContain(2322);
    } finally {
        await daemon.close();
    }
});
