import { createServer } from "node:net";
import { freePort } from "@intentic/base/fs";
import type { LoopbackCatch, LoopbackCatchEvent } from "@intentic/sandbox-contract";
import { catchLoopback } from "./loopback-catch.js";

const specFor = (port: number, overrides: Partial<LoopbackCatch> = {}): LoopbackCatch => ({
    id: "attempt-1",
    host: "localhost",
    port,
    path: "/callback",
    expiresAt: Date.now() + 60_000,
    title: "Claude",
    ...overrides,
});

const next = async (stream: AsyncGenerator<LoopbackCatchEvent>): Promise<LoopbackCatchEvent | undefined> => (await stream.next()).value ?? undefined;

test("hands back the whole landing address and thanks the tab, then stops listening when aborted", async () => {
    const port = await freePort();
    const abort = new AbortController();
    const stream = catchLoopback(specFor(port), abort.signal, () => {});
    expect(await next(stream)).toEqual({ type: "listening" });
    const landing = fetch(`http://127.0.0.1:${port}/callback?code=abc&state=xyz`);
    expect(await next(stream)).toEqual({ type: "landed", url: `http://localhost:${port}/callback?code=abc&state=xyz` });
    const page = await landing;
    expect(page.status).toBe(200);
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await page.text()).toContain("Signed in to Claude");
    abort.abort();
    expect(await stream.next()).toEqual({ done: true, value: undefined });
    await expect(fetch(`http://127.0.0.1:${port}/callback`)).rejects.toThrow();
});

test("answers anything off the path with a 404 and passes nothing up", async () => {
    const port = await freePort();
    const abort = new AbortController();
    const stream = catchLoopback(specFor(port), abort.signal, () => {});
    expect(await next(stream)).toEqual({ type: "listening" });
    expect((await fetch(`http://127.0.0.1:${port}/favicon.ico`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/callback`, { method: "POST" })).status).toBe(404);
    const landing = fetch(`http://127.0.0.1:${port}/callback?code=real`);
    expect(await next(stream)).toEqual({ type: "landed", url: `http://localhost:${port}/callback?code=real` });
    await landing;
    abort.abort();
    await stream.return(undefined);
});

test("says the port is busy rather than failing the stream when something already holds it", async () => {
    const port = await freePort();
    const holder = createServer();
    await new Promise<void>((resolve) => holder.listen(port, "127.0.0.1", resolve));
    try {
        const stream = catchLoopback(specFor(port, { host: "127.0.0.1" }), undefined, () => {});
        expect(await next(stream)).toEqual({ type: "busy", reason: `port ${port} is already taken on this machine` });
        expect(await stream.next()).toEqual({ done: true, value: undefined });
    } finally {
        await new Promise<void>((resolve) => holder.close(() => resolve()));
    }
});

test("lets the port go by itself once the attempt's deadline passes", async () => {
    const port = await freePort();
    const stream = catchLoopback(specFor(port, { expiresAt: Date.now() + 150 }), undefined, () => {});
    expect(await next(stream)).toEqual({ type: "listening" });
    expect(await stream.next()).toEqual({ done: true, value: undefined });
    await expect(fetch(`http://127.0.0.1:${port}/callback`)).rejects.toThrow();
});

test("a consumer that stops reading releases the port too", async () => {
    const port = await freePort();
    const stream = catchLoopback(specFor(port), undefined, () => {});
    expect(await next(stream)).toEqual({ type: "listening" });
    await stream.return(undefined);
    await expect(fetch(`http://127.0.0.1:${port}/callback`)).rejects.toThrow();
});
