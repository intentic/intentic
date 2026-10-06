import { type CliIo, runWhatsAppCli } from "./cli.js";

// What an agent sees from `whatsapp …`: stdout only (it drops stderr) and an exit code that never reads a failure as an
// answer.
const harness = (gateway: string | undefined, answer?: () => Promise<Response>) => {
    const out: string[] = [];
    const requests: { url: string; init: RequestInit }[] = [];
    const io: CliIo = {
        gatewayUrl: async () => gateway,
        fetch: async (url, init) => {
            requests.push({ url, init });
            return answer === undefined ? new Response("sent") : answer();
        },
        write: (text) => void out.push(text),
    };
    return { io, out, requests };
};

test("a command becomes its gateway request, and the gateway's answer is the output", async () => {
    const h = harness("http://127.0.0.1:9");
    expect(await runWhatsAppCli(["send", "+447700900123", "on", "my", "way"], h.io)).toBe(0);
    expect(h.requests.map(({ url, init }) => ({ url, body: init.body }))).toEqual([
        { url: "http://127.0.0.1:9/send", body: JSON.stringify({ chat: "+447700900123", text: "on my way" }) },
    ]);
    expect(h.out).toEqual(["sent\n"]);
});

test("a usage error is printed to stdout with exit 2, not to stderr with a code that could mean 'nothing found'", async () => {
    const h = harness("http://127.0.0.1:9");
    expect(await runWhatsAppCli(["send", "only-a-chat"], h.io)).toBe(2);
    expect(h.out.join("")).toContain("usage: whatsapp <command>");
    expect(await runWhatsAppCli(["toString"], h.io)).toBe(2);
    expect(h.requests).toEqual([]);
});

test("a gateway that is not running, not answering or refusing is exit 2 with the reason on stdout", async () => {
    const missing = harness(undefined);
    expect(await runWhatsAppCli(["chats"], missing.io)).toBe(2);
    expect(missing.out.join("")).toContain("isn't running yet");

    const down = harness("http://127.0.0.1:9", () => Promise.reject(new Error("ECONNREFUSED")));
    expect(await runWhatsAppCli(["chats"], down.io)).toBe(2);
    expect(down.out.join("")).toContain("did not answer");

    const refused = harness("http://127.0.0.1:9", async () => new Response("No single WhatsApp chat matches Bob.", { status: 409 }));
    expect(await runWhatsAppCli(["send", "Bob", "hi"], refused.io)).toBe(2);
    expect(refused.out).toEqual(["whatsapp: No single WhatsApp chat matches Bob.\n"]);
});
