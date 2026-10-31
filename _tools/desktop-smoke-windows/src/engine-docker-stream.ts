import { spawn } from "node:child_process";
import type { RequestOptions } from "node:http";
import { connect } from "node:net";
import { Duplex } from "node:stream";

/** Docker's Windows pipe needs its own half-close protocol: Node's pipe.end() closes the output too. */
export const openEngineDockerStream = async (upstream: RequestOptions): Promise<Duplex> => {
    if (upstream.socketPath !== undefined) {
        const host = upstream.socketPath.replace("\\\\.\\pipe\\", "npipe:////./pipe/");
        const child = spawn("docker", ["--host", host, "system", "dial-stdio"], {
            stdio: ["pipe", "pipe", "ignore"], windowsHide: true,
        });
        // Docker's bridge forwards stdin EOF using the pipe's half-close protocol and keeps stdout open.
        const stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
        child.on("error", (error) => stream.destroy(error));
        child.on("exit", (code) => {
            if (code !== 0) { stream.destroy(new Error(`Docker's stream bridge exited ${code}`)); }
        });
        stream.on("error", () => child.kill());
        stream.once("close", () => child.kill());
        await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
        return stream;
    }
    const socket = connect({ host: upstream.hostname ?? "127.0.0.1", port: Number(upstream.port), allowHalfOpen: true });
    socket.setTimeout(30_000, () => socket.destroy(new Error("Docker's stream connection timed out")));
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    socket.setTimeout(0);
    return socket;
};
