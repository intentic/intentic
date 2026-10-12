import { answeringFetch, streamedResponse } from "../../http/fetch.testing.js";
import { McpCallError, McpClient } from "./mcp-client.js";

const SERVER = { name: "acme", url: "https://mcp.example.com/acme" };
const MIB = 1024 * 1024;

describe("McpClient", () => {
    it("refuses an event-stream answer past its cap that declares no length, without reading it all", async () => {
        // 64 MiB offered in 1 MiB chunks; the cap is 8 MiB.
        const { response, pulled } = streamedResponse(64, MIB, 0x20, { headers: { "content-type": "text/event-stream" } });
        const client = new McpClient(
            SERVER,
            answeringFetch(() => response),
        );

        const failure = await client.request("tools/list").then(
            () => undefined,
            (error: unknown) => error,
        );

        expect(failure).toBeInstanceOf(McpCallError);
        expect(failure instanceof Error ? failure.message : failure).toBe("acme's answer to initialize is too large");
        expect(pulled.cancelled).toBe(true);
        expect(pulled.count).toBeLessThanOrEqual(10);
    });

    it("reads an answer under the cap", async () => {
        // The handshake, the notification that follows it (no answer), then the list.
        const answers = [{ jsonrpc: "2.0", id: 1, result: {} }, undefined, { jsonrpc: "2.0", id: 2, result: { tools: [{ name: "draw" }] } }];
        const fetcher = answeringFetch((call) => {
            const answer = answers[call - 1];
            return new Response(answer === undefined ? null : JSON.stringify(answer), { status: answer === undefined ? 202 : 200 });
        });

        expect(await new McpClient(SERVER, fetcher).tools()).toEqual([{ name: "draw" }]);
    });

    it("finds the answer in an event stream, past a keep-alive and a notification, its data split over lines", async () => {
        const stream = (text: string): Response => new Response(text, { headers: { "content-type": "text/event-stream" } });
        const answers = [
            stream(`data: {"jsonrpc":"2.0","id":1,"result":{}}\n\n`),
            new Response(null, { status: 202 }),
            stream(
                `: ping\r\n\r\nevent: message\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\r\n\r\n` +
                    `event: message\r\ndata: {"jsonrpc":"2.0","id":2,\r\ndata: "result":{"tools":[{"name":"draw"}]}}\r\n\r\n`,
            ),
        ];
        const fetcher = answeringFetch((call) => answers[call - 1] ?? new Response(null, { status: 500 }));

        expect(await new McpClient(SERVER, fetcher).tools()).toEqual([{ name: "draw" }]);
    });
});
