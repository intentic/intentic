import net from "node:net";

/* An OS-assigned free loopback port, taken by binding one and letting go. */
export const freePort = (): Promise<number> =>
    new Promise((resolve, reject) => {
        const server = net.createServer();
        server.on("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            const port = typeof address === "object" && address !== null ? address.port : 0;
            server.close(() => (port === 0 ? reject(new Error("no free port")) : resolve(port)));
        });
    });
