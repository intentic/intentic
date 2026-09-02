import net from "node:net";

/* An OS-assigned free loopback port, taken by binding one and letting go. It was the same nine lines in the
 * panel manager, the service supervisor, the extension backend host and the browser launcher, each with its own
 * comment about the TOCTOU below; here it is once.
 *
 * ponytail: a tiny window between letting go and the child's own bind, in which a second caller planned in the
 * same moment could be handed the same number. Fine for a handful of processes that own their port a moment
 * later; a caller that must not repeat a number in flight (browser-tools.ts) keeps its own memory on top. */
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
