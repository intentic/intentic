import { type CliIo, runVoiceCli } from "./cli.js";

// What an agent sees from `discord-voice …`: stdout only (it drops stderr) and an exit code that never reads a failure as
// an answer.
const harness = (gateway: string | undefined, answer?: () => Promise<Response>, piped = "") => {
    const out: string[] = [];
    const paths: string[] = [];
    const bodies: Array<string | undefined> = [];
    const io: CliIo = {
        gatewayUrl: async () => gateway,
        fetch: async (url, init) => {
            paths.push(url);
            bodies.push(init.body === undefined || init.body === null ? undefined : String(init.body));
            return answer === undefined ? new Response("joined General") : answer();
        },
        write: (text) => void out.push(text),
        stdin: async () => piped,
    };
    return { io, out, paths, bodies };
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
    expect(await runVoiceCli(["say"], h.io)).toBe(2);
    expect(await runVoiceCli(["say", "  "], h.io)).toBe(2);
    expect(h.out).toEqual([
        "usage: discord-voice join <channelId>\n",
        "usage: discord-voice <join <channelId> | say <text> | stop | leave | status>\n",
        "usage: discord-voice say <text>   (or `-` to read the text from stdin)\n",
        "usage: discord-voice say <text>   (or `-` to read the text from stdin)\n",
    ]);
    expect(h.paths).toEqual([]);
});

test("say posts its words to the gateway, joining unquoted words back into one line", async () => {
    const h = harness("http://127.0.0.1:9", async () => new Response("Speaking in #general."));
    expect(await runVoiceCli(["say", "The build passed."], h.io)).toBe(0);
    expect(await runVoiceCli(["say", "Deploying", "now."], h.io)).toBe(0);
    expect(h.paths).toEqual(["http://127.0.0.1:9/voice/say", "http://127.0.0.1:9/voice/say"]);
    expect(h.bodies).toEqual([JSON.stringify({ text: "The build passed." }), JSON.stringify({ text: "Deploying now." })]);
    expect(h.out).toEqual(["Speaking in #general.\n", "Speaking in #general.\n"]);
});

test("say - reads the words from stdin, and says nothing when stdin held none", async () => {
    const piped = harness("http://127.0.0.1:9", async () => new Response("Speaking in #general."), "It's \"done\",\nshipped.\n");
    expect(await runVoiceCli(["say", "-"], piped.io)).toBe(0);
    expect(piped.bodies).toEqual([JSON.stringify({ text: 'It\'s "done",\nshipped.' })]);

    const empty = harness("http://127.0.0.1:9", undefined, "\n");
    expect(await runVoiceCli(["say", "-"], empty.io)).toBe(2);
    expect(empty.paths).toEqual([]);
});

test("stop posts to the gateway with no body", async () => {
    const h = harness("http://127.0.0.1:9", async () => new Response("Stopped speaking in #general."));
    expect(await runVoiceCli(["stop"], h.io)).toBe(0);
    expect(h.paths).toEqual(["http://127.0.0.1:9/voice/stop"]);
    expect(h.bodies).toEqual([undefined]);
    expect(h.out).toEqual(["Stopped speaking in #general.\n"]);
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
