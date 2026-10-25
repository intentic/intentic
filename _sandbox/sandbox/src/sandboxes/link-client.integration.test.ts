import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { LINK_HEADER } from "@intentic/sandbox-contract/schemas/links";
import { linkHello } from "./link-client.js";

let source: Server;
let destination: Server;
let sourceUrl: string;
let destinationSeen: IncomingHttpHeaders[];
let sourceSeen: IncomingHttpHeaders[];

beforeAll(async () => {
    destinationSeen = [];
    sourceSeen = [];
    destination = createServer((request, response) => {
        destinationSeen.push(request.headers);
        response.end(
            JSON.stringify({ sandbox: "elsewhere", link: { id: "link", label: "Link" }, terms: { approve: false, turnsPerHour: 1 }, maxHops: 1 }),
        );
    });
    await new Promise<void>((resolve) => destination.listen(0, "127.0.0.1", () => resolve()));
    // SAFETY: a server listening on TCP returns an AddressInfo.
    const destinationUrl = `http://127.0.0.1:${(destination.address() as AddressInfo).port}/link`;
    source = createServer((request, response) => {
        sourceSeen.push(request.headers);
        response.writeHead(302, { location: destinationUrl });
        response.end();
    });
    await new Promise<void>((resolve) => source.listen(0, "127.0.0.1", () => resolve()));
    // SAFETY: a server listening on TCP returns an AddressInfo.
    sourceUrl = `http://127.0.0.1:${(source.address() as AddressInfo).port}`;
});

afterAll(async () => {
    await new Promise<void>((resolve) => source.close(() => resolve()));
    await new Promise<void>((resolve) => destination.close(() => resolve()));
});

test("a linked sandbox cannot redirect its private link token to another origin", async () => {
    const answer = await linkHello({ id: "link", config: { url: sourceUrl, token: "private-link-token" } });
    expect(sourceSeen.map((headers) => headers[LINK_HEADER])).toEqual(["private-link-token"]);
    expect(destinationSeen).toEqual([]);
    expect(answer).toEqual({ ok: false, status: 302, message: "it answered 302" });
});
