import { readGatewayUrl } from "@intentic/connector-runtime";

// The agent's voice control tool (`bin/discord-voice`): join <channelId>, leave, status. It forwards to the long-lived
// gateway process, which holds the voice session across turns, over the loopback control surface whose address the
// gateway publishes for readGatewayUrl.
// The agent-CLI contract: everything, errors included, goes to stdout, since an agent drops stderr; exit 0 is an answer,
// 2 anything else (a usage error, a gateway that is down or refused).

const USAGE = "usage: discord-voice <join <channelId> | leave | status>\n";

export interface CliIo {
    readonly gatewayUrl: () => Promise<string | undefined>;
    readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
    readonly write: (text: string) => void;
}

const requestOf = (command: string, channelId: string | undefined): { path: string; init: RequestInit } | undefined => {
    if (command === "join") {
        return channelId === undefined || channelId === ""
            ? undefined
            : { path: "/voice/join", init: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ channelId }) } };
    }
    if (command === "leave") {
        return { path: "/voice/leave", init: { method: "POST" } };
    }
    return command === "status" ? { path: "/voice/status", init: {} } : undefined;
};

// Runs one command and returns its exit code; what it prints goes through `io.write`.
export const runVoiceCli = async (argv: readonly string[], io: CliIo): Promise<number> => {
    const [command = "", channelId] = argv;
    const request = requestOf(command, channelId);
    if (request === undefined) {
        io.write(command === "join" ? "usage: discord-voice join <channelId>\n" : USAGE);
        return 2;
    }
    const base = await io.gatewayUrl();
    if (base === undefined) {
        io.write("discord-voice: the Discord gateway isn't running yet (no gateway.url). It starts with the sandbox, wait a moment and retry.\n");
        return 2;
    }
    let res: Response;
    try {
        res = await io.fetch(`${base}${request.path}`, request.init);
    } catch (error) {
        io.write(`discord-voice: couldn't reach the Discord gateway: ${error instanceof Error ? error.message : String(error)}\n`);
        return 2;
    }
    const text = await res.text();
    const body = res.ok ? text : `discord-voice: ${text}`;
    io.write(body.endsWith("\n") ? body : `${body}\n`);
    return res.ok ? 0 : 2;
};

export const main = async (): Promise<void> => {
    process.exitCode = await runVoiceCli(process.argv.slice(2), {
        gatewayUrl: () => readGatewayUrl("discord"),
        fetch: (url, init) => fetch(url, init),
        write: (text) => void process.stdout.write(text),
    });
};
