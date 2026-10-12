import { text as readAll } from "node:stream/consumers";
import { readGatewayUrl } from "@intentic/connector-runtime";

// The agent's voice control tool (`bin/discord-voice`): join <channelId>, say <text>, stop, leave, status. It forwards to
// the long-lived gateway process, which holds the voice session across turns, over the loopback control surface whose
// address the gateway publishes for readGatewayUrl.
// The agent-CLI contract: everything, errors included, goes to stdout, since an agent drops stderr; exit 0 is an answer,
// 2 anything else (a usage error, a gateway that is down or refused).

const USAGE = "usage: discord-voice <join <channelId> | say <text> | stop | leave | status>\n";

// The usage line for a command given without what it needs, or for one there is no such command as.
const usageOf = (command: string): string => {
    switch (command) {
        case "join":
            return "usage: discord-voice join <channelId>\n";
        case "say":
            return "usage: discord-voice say <text>   (or `-` to read the text from stdin)\n";
        default:
            return USAGE;
    }
};

export interface CliIo {
    readonly gatewayUrl: () => Promise<string | undefined>;
    readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
    readonly write: (text: string) => void;
    // Everything piped in, read only for `say -`.
    readonly stdin: () => Promise<string>;
}

// One call to the gateway's control surface.
interface GatewayRequest {
    readonly path: string;
    readonly init: RequestInit;
}

const postJson = (path: string, body: Readonly<Record<string, string>>): GatewayRequest => ({
    path,
    init: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
});

// What a command acts on: join's channel id, or say's words, the rest of the line (unquoted words are joined back up)
// or stdin for a lone `-`, which keeps quotes and newlines in an agent's text out of the shell's way.
const argumentOf = async (command: string, rest: readonly string[], io: CliIo): Promise<string> => {
    if (command !== "say") {
        return rest[0] ?? "";
    }
    return (rest.length === 1 && rest[0] === "-" ? await io.stdin() : rest.join(" ")).trim();
};

const requestOf = (command: string, argument: string): GatewayRequest | undefined => {
    switch (command) {
        case "join":
            return argument === "" ? undefined : postJson("/voice/join", { channelId: argument });
        case "say":
            return argument === "" ? undefined : postJson("/voice/say", { text: argument });
        case "stop":
            return { path: "/voice/stop", init: { method: "POST" } };
        case "leave":
            return { path: "/voice/leave", init: { method: "POST" } };
        case "status":
            return { path: "/voice/status", init: {} };
        default:
            return undefined;
    }
};

// Runs one command and returns its exit code; what it prints goes through `io.write`.
export const runVoiceCli = async (argv: readonly string[], io: CliIo): Promise<number> => {
    const [command = "", ...rest] = argv;
    const request = requestOf(command, await argumentOf(command, rest, io));
    if (request === undefined) {
        io.write(usageOf(command));
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
        write: (output) => void process.stdout.write(output),
        stdin: () => readAll(process.stdin),
    });
};
