import { connect, type Socket } from "node:net";
import { errorMessage } from "@intentic/base/errors";
import { type Pump, pumpTcpWebSocket } from "@intentic/base/ws-tcp-pump";
import type { DialLoopback, DeviceScopes } from "@intentic/sandbox-contract";
import { assertScope } from "../../policy.js";

// THIS MACHINE'S END OF A `devices reach` TUNNEL (the daemon's is hosts/device-tunnels.ts). The sandbox accepted a
// connection on its side and asks, over the link, for one to this machine's own loopback port. The local port is dialled
// first, so "nothing listens there" is said to the sandbox before any WebSocket is opened; then a WebSocket goes back to
// the daemon this link dialled, with the one-time ticket, and the pump desktop sync's ssh transport runs carries both
// directions. Nothing listens on this machine for it: every byte rides a connection this machine opened.
//
// Allowed when "Run commands" or "Run programs this sandbox sends" is on: either already lets the sandbox reach this
// machine's loopback (a curl, or a program it sent), so this adds no reach of its own.

const OPEN_TIMEOUT_MS = 10_000;

export const tunnelSocketUrl = (base: string): string => `${base.replace(/\/$/, "").replace(/^http/, "ws")}/system/hosts/tunnel`;

const dialLocal = async (port: number): Promise<Socket> => {
    let lastError: unknown;
    // 127.0.0.1 first; a dev server bound to `localhost` on a machine that resolves it to ::1 answers only there.
    for (const host of ["127.0.0.1", "::1"]) {
        try {
            // oxlint-disable-next-line eslint/no-await-in-loop -- two addresses, the second only when the first refused
            return await new Promise<Socket>((done, fail) => {
                const socket = connect({ port, host });
                socket.once("connect", () => {
                    socket.off("error", fail);
                    done(socket);
                });
                socket.once("error", fail);
            });
        } catch (error) {
            lastError = error;
        }
    }
    const code = (lastError as NodeJS.ErrnoException | undefined)?.code;
    throw new Error(
        code === "ECONNREFUSED" ? `nothing is listening on port ${port} on this computer (127.0.0.1 or ::1)` : `could not reach port ${port} here: ${errorMessage(lastError)}`,
    );
};

export const dialLoopback = async (input: DialLoopback, scopes: DeviceScopes, base: string | undefined): Promise<{ ok: true }> => {
    if (scopes.shell !== "on") {
        assertScope(scopes, "programs");
    }
    if (base === undefined) {
        throw new Error("this link is not connected right now");
    }
    const socket = await dialLocal(input.port);
    socket.pause();
    const ws = new WebSocket(tunnelSocketUrl(base), { headers: { "x-intentic-tunnel": input.ticket } } as never);
    ws.binaryType = "arraybuffer";
    let pump: Pump | undefined;
    const close = (): void => {
        pump?.stop();
        pump = undefined;
        socket.destroy();
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            ws.close();
        }
    };
    socket.on("close", close);
    socket.on("error", close);
    ws.addEventListener("message", (event: MessageEvent) => pump?.inbound(event.data));
    ws.addEventListener("close", close);
    await new Promise<void>((done, fail) => {
        const timer = setTimeout(() => {
            close();
            fail(new Error(`the tunnel back to the sandbox did not open within ${OPEN_TIMEOUT_MS / 1000}s`));
        }, OPEN_TIMEOUT_MS);
        ws.addEventListener("open", () => {
            clearTimeout(timer);
            pump = pumpTcpWebSocket(
                socket,
                { send: (frame) => ws.send(frame), bufferedAmount: () => ws.bufferedAmount },
                { onOverflow: close },
            );
            done();
        });
        ws.addEventListener("error", () => {
            clearTimeout(timer);
            close();
            fail(new Error("the tunnel back to the sandbox could not be opened"));
        });
    });
    return { ok: true };
};
