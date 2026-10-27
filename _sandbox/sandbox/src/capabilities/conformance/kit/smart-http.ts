import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { runCommand, shellQuote, successful } from "./command.js";

export const smartHttpRepository = async (root: string, repo: string) => {
    const projects = join(root, "projects");
    const bare = join(projects, `${repo}.git`);
    await mkdir(bare, { recursive: true });
    const seed = join(root, "seed");
    await successful(
        runCommand(
            `git init --bare --initial-branch=main ${shellQuote(bare)}
git init --initial-branch=main ${shellQuote(seed)}
git -C ${shellQuote(seed)} -c user.name=Conformance -c user.email=conformance@example.invalid commit --allow-empty -m seed
git -C ${shellQuote(seed)} push ${shellQuote(bare)} HEAD:main
git -C ${shellQuote(bare)} config http.receivepack true`,
            { home: root },
        ),
    );
    const executable = (await successful(runCommand("git --exec-path", { home: root }))).trim();
    const serve = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
        const url = new URL(request.url ?? "/", "http://localhost");
        const input: Buffer[] = [];
        for await (const chunk of request) {
            input.push(Buffer.from(chunk));
        }
        const body = Buffer.concat(input);
        const exchange = await mkdtemp(join(root, "http-backend-"));
        let output: Buffer;
        try {
            const inputFile = join(exchange, "request");
            const outputFile = join(exchange, "response");
            // runCheck captures text; files preserve the CGI protocol's binary bytes.
            await writeFile(inputFile, body);
            await successful(
                runCommand(`exec ${shellQuote(join(executable, "git-http-backend"))} < ${shellQuote(inputFile)} > ${shellQuote(outputFile)}`, {
                    home: root,
                    env: {
                        GIT_PROJECT_ROOT: projects,
                        GIT_HTTP_EXPORT_ALL: "1",
                        PATH_INFO: decodeURIComponent(url.pathname),
                        QUERY_STRING: url.search.slice(1),
                        REQUEST_METHOD: request.method ?? "GET",
                        CONTENT_TYPE: request.headers["content-type"] ?? "",
                        CONTENT_LENGTH: String(body.length),
                        REMOTE_USER: "conformance",
                        REMOTE_ADDR: "127.0.0.1",
                        HTTP_GIT_PROTOCOL: String(request.headers["git-protocol"] ?? ""),
                    },
                }),
            );
            output = await readFile(outputFile);
        } finally {
            await rm(exchange, { recursive: true, force: true });
        }
        const boundary = output.indexOf("\r\n\r\n");
        if (boundary === -1) {
            throw new Error("git http-backend returned no CGI headers");
        }
        for (const line of output.subarray(0, boundary).toString().split("\r\n")) {
            const colon = line.indexOf(":");
            const key = line.slice(0, colon);
            const value = line.slice(colon + 1).trim();
            if (key.toLowerCase() === "status") {
                response.statusCode = Number(value.split(" ")[0]);
            } else {
                response.setHeader(key, value);
            }
        }
        response.end(output.subarray(boundary + 4));
    };
    return { bare, serve };
};
