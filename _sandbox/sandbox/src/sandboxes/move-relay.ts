import { connect, type Socket } from "node:net";
import type { DeviceTunnels } from "../hosts/device-tunnels.js";
import type { RelayEnd } from "./move-gate.js";

/* THE RELAY A MOVE FALLS BACK TO (2026-11-11). When the source's ic cannot dial the target directly (a firewall, a WSL
NAT, two networks), it listens on its own loopback instead, and this daemon joins the two computers through the
`devices reach` tunnels it already has: one to the source's port, one to the target's, and the two local ends piped into
each other. Only the move's ciphertext passes here: the stream is sealed between the two ic processes with keys this
daemon never holds, and it carried only their public halves. Each tunnel needs its computer's "Run commands" or "Run
programs" switch, as every `devices reach` does; without one the open fails and the move is reported failed, with the
sandbox back where it was. */

const opened = (socket: Socket): Promise<Socket> =>
    new Promise((resolve, reject) => {
        socket.once("connect", () => resolve(socket));
        socket.once("error", reject);
    });

export const relayThroughTunnels =
    (tunnels: DeviceTunnels) =>
    async (from: RelayEnd, to: RelayEnd): Promise<{ readonly close: () => Promise<void> }> => {
        const close = async (): Promise<void> => {
            await tunnels.close(from.device, from.port);
            await tunnels.close(to.device, to.port);
        };
        try {
            const sourceEnd = await tunnels.open(from.device, from.port, 0);
            const targetEnd = await tunnels.open(to.device, to.port, 0);
            const [a, b] = await Promise.all([opened(connect(sourceEnd.localPort, "127.0.0.1")), opened(connect(targetEnd.localPort, "127.0.0.1"))]);
            a.pipe(b);
            b.pipe(a);
            // One side ending ends the other: a half-open relay would hold the far ic until its stall limit.
            for (const [one, other] of [
                [a, b],
                [b, a],
            ] as const) {
                one.on("error", () => other.destroy());
                one.on("close", () => other.destroy());
            }
            return {
                close: async () => {
                    a.destroy();
                    b.destroy();
                    await close();
                },
            };
        } catch (error) {
            await close();
            throw error;
        }
    };
