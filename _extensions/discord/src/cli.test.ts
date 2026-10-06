import { type CliIo, runVoiceCli } from "./cli.js";

// What an agent sees from `discord-voice …`: stdout only (it drops stderr) and an exit code that never reads a failure as
// an answer.
const harness = (gateway: string | undefined, answer?: () => Promise<Response>) => {
    const out: string[] = [];
    const paths: string[] = [];
    const io: CliIo = {
        gatewayUrl: async () => gateway,
        fetch: async (url) => {
            paths.push(url);
            return answer === undefined ? new Response("joined General") : answer();
        },
        write: (text) => void out.push(text),
    };
    return { io, out, paths };
};

test("join posts the channel to the gateway and prints its answer", async () => {
    const h = harness("http://127.0.0.1:9");
    expect(await runVoiceCli(["join", "123"], h.io)).toBe(0);
    expect(h.paths).toEqual(["http://127.0.0.1:9/voice/join"]);
    expect(h.out).toEqual(["joined General\n"]);
});

test("a usage error goes to stdout with exit 2, and reaches no gateway", async () => {
    const h = harness("http://127.0.0.1:9");
    expect(await runVoiceCli(["join"], h.io)).toBe(2);
    expect(await runVoiceCli(["dance"], h.io)).toBe(2);
    expect(h.out).toEqual(["usage: discord-voice join <channelId>\n", "usage: discord-voice <join <channelId> | leave | status>\n"]);
    expect(h.paths).toEqual([]);
});

test("a missing, unreachable or refusing gateway is exit 2 with the reason on stdout", async () => {
    const missing = harness(undefined);
    expect(await runVoiceCli(["status"], missing.io)).toBe(2);
    expect(missing.out.join("")).toContain("isn't running yet");

    const down = harness("http://127.0.0.1:9", () => Promise.reject(new Error("ECONNREFUSED")));
    expect(await runVoiceCli(["leave"], down.io)).toBe(2);
    expect(down.out).toEqual(["discord-voice: couldn't reach the Discord gateway: ECONNREFUSED\n"]);

    const refused = harness("http://127.0.0.1:9", async () => new Response("channelId required", { status: 400 }));
    expect(await runVoiceCli(["join", "1"], refused.io)).toBe(2);
    expect(refused.out).toEqual(["discord-voice: channelId required\n"]);
});
