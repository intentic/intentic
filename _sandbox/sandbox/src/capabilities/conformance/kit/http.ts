import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { z } from "zod";

export const listen = async (server: Server) => {
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = z.object({ port: z.number() }).parse(server.address());
    return {
        port: address.port,
        origin: `http://127.0.0.1:${String(address.port)}`,
        close: () =>
            new Promise<void>((resolve, reject) => {
                server.close((error) => (error === undefined ? resolve() : reject(error)));
                server.closeAllConnections();
            }),
    };
};

export const httpServer = (handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>) =>
    listen(
        createServer((request, response) => {
            void handler(request, response).catch((error: Error) => {
                response.writeHead(500, { "content-type": "text/plain" });
                response.end(error.message);
            });
        }),
    );
