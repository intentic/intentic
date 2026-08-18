import { createServer, type Server } from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import { isListening } from "./probe.ts";

/* The guard that keeps a leftover `pnpm dev` from being published: it holds the ports with a platform
 * configured for localhost, and the only symptom downstream is minted links (invite mail) still saying
 * localhost while the public address answers perfectly. */

let server: Server | undefined;

const listen = async (): Promise<number> => {
    server = createServer();
    await new Promise<void>((resolve) => server?.listen(0, `127.0.0.1`, resolve));
    return (server.address() as AddressInfo).port;
};

afterEach(async () => {
    await new Promise<void>((resolve) => (server === undefined ? resolve() : server.close(() => resolve())));
    server = undefined;
});

it(`sees a port something is already serving`, async () => {
    const port = await listen();

    await expect(isListening(port)).resolves.toBe(true);
});

it(`sees a free port as free — the ordinary start, where the tool goes on to bind the tunnel`, async () => {
    // Bind one, then release it: a port nobody answers on, without guessing a number some other suite holds.
    const port = await listen();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;

    await expect(isListening(port)).resolves.toBe(false);
});
