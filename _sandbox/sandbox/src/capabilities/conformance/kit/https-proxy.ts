import { createServer as createHttpsServer } from "node:https";
import { createServer } from "node:http";
import { connect, type Socket } from "node:net";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runCommand, shellQuote, successful } from "./command.js";
import { listen } from "./http.js";

// A trusted local CONNECT proxy keeps git's URL and credential lookup on the declared HTTPS host.
export const httpsProxy = async (root: string, hostname: string, destination: string) => {
    const key = join(root, "proxy.key");
    const cert = join(root, "proxy.crt");
    await successful(
        runCommand(
            `openssl req -x509 -newkey rsa:2048 -nodes -days 1 -keyout ${shellQuote(key)} -out ${shellQuote(cert)} -subj ${shellQuote(`/CN=${hostname}`)} -addext ${shellQuote(`subjectAltName=DNS:${hostname}`)}`,
            { home: root },
        ),
    );
    const tls = createHttpsServer({ key: await readFile(key), cert: await readFile(cert) }, (request, response) => {
        void (async () => {
            const chunks: Buffer[] = [];
            for await (const chunk of request) {
                chunks.push(Buffer.from(chunk));
            }
            const upstream = await fetch(`${destination}${request.url ?? "/"}`, {
                method: request.method ?? "GET",
                headers: Object.fromEntries(
                    Object.entries(request.headers).flatMap(([name, value]) => (value === undefined ? [] : [[name, String(value)]])),
                ),
                body: request.method === "POST" ? Buffer.concat(chunks) : null,
                redirect: "manual",
            });
            response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
            response.end(Buffer.from(await upstream.arrayBuffer()));
        })().catch((error: Error) => {
            response.writeHead(502);
            response.end(error.message);
        });
    });
    const localTls = await listen(tls);
    const sockets = new Set<Socket>();
    const proxy = createServer((_request, response) => {
        response.writeHead(403);
        response.end("conformance proxy refuses HTTP origins");
    });
    proxy.on("connect", (request, client, head) => {
        if (request.url !== `${hostname}:443`) {
            client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
            return;
        }
        const upstream = connect(localTls.port, "127.0.0.1", () => {
            client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            upstream.write(head);
            client.pipe(upstream).pipe(client);
        });
        sockets.add(upstream);
        upstream.on("error", () => client.destroy());
        client.on("error", () => upstream.destroy());
        upstream.on("close", () => {
            sockets.delete(upstream);
            client.destroy();
        });
        client.on("close", () => upstream.destroy());
    });
    const localProxy = await listen(proxy);
    return {
        env: {
            HTTPS_PROXY: localProxy.origin,
            https_proxy: localProxy.origin,
            http_proxy: localProxy.origin,
            ALL_PROXY: localProxy.origin,
            NO_PROXY: "127.0.0.1,localhost",
            no_proxy: "127.0.0.1,localhost",
            GIT_SSL_CAINFO: cert,
        },
        close: async () => {
            for (const socket of sockets) {
                socket.destroy();
            }
            await localProxy.close();
            await localTls.close();
        },
    };
};
