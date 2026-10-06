import { errorMessage } from "@intentic/base/errors";
import { readGatewayUrl } from "@intentic/connector-runtime";

// The agent's WhatsApp tool (`bin/whatsapp`). WhatsApp has no public API to curl: the paired socket lives in the
// long-lived gateway process, so every command forwards to the gateway's loopback control surface, whose address the
// gateway publishes for readGatewayUrl. A <chat> is a JID, a phone number with country code, or a name (quote a name
// with spaces); the gateway resolves it and refuses an ambiguous one with the candidates.
// The agent-CLI contract: everything, errors included, goes to stdout, since an agent drops stderr; exit 0 is an answer,
// 2 anything else (a usage error, a gateway that is down or refused). There is no "found nothing" 1: the gateway
// answers an empty search in words.

const USAGE = `usage: whatsapp <command>
  chats [query]                        every known chat, most recent first (or those matching query)
  contacts <query…>                    people and groups whose name or number matches
  history <chat> [count]               the chat's last messages (default 30), asking the phone for older ones
  send <chat> <text…>                  send a message
  reply <chat> <messageId> <text…>     send a message quoting an earlier one
  send-file <chat> <path>              send a file (images as photos, audio as playable audio)
  send-voice <chat> <path>             send audio as a voice note
  react <chat> <messageId> <emoji>     react to a message ("" removes our reaction)
  download <messageId>                 save a received photo/voice note/document and print its path
<chat> is a JID, a phone number with country code, or a name ("Vicheta Samnang" in quotes).`;

interface GatewayRequest {
    readonly path: string;
    readonly init: RequestInit;
}

// What a command sends the gateway: its arguments by name, a missing optional one simply absent.
type Payload = Readonly<Record<string, string | boolean | undefined>>;

const post = (path: string, payload: Payload): GatewayRequest => ({
    path,
    init: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) },
});
const get = (path: string, params: Record<string, string>): GatewayRequest => ({ path: `${path}?${new URLSearchParams(params).toString()}`, init: {} });

// Each command: how many arguments it needs at least, and the request it becomes.
type CommandSpec = readonly [number, (rest: readonly string[]) => GatewayRequest];
const COMMANDS = new Map<string, CommandSpec>([
    ["chats", [0, (rest) => get("/chats", { q: rest.join(" ") })]],
    ["contacts", [1, (rest) => get("/contacts", { q: rest.join(" ") })]],
    // path-literals: content, "/history" is the gateway's own HTTP route, not the daemon's history root
    ["history", [1, ([chat = "", count = ""]) => get("/history", { chat, limit: count })]],
    ["send", [2, ([chat, ...text]) => post("/send", { chat, text: text.join(" ") })]],
    ["reply", [3, ([chat, reply, ...text]) => post("/send", { chat, reply, text: text.join(" ") })]],
    ["send-file", [2, ([chat, path]) => post("/send-file", { chat, path })]],
    ["send-voice", [2, ([chat, path]) => post("/send-file", { chat, path, voice: true })]],
    ["react", [3, ([chat, id, emoji]) => post("/react", { chat, id, emoji })]],
    ["download", [1, ([id]) => post("/download", { id })]],
]);

export interface CliIo {
    readonly gatewayUrl: () => Promise<string | undefined>;
    readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
    readonly write: (text: string) => void;
}

const line = (text: string): string => (text.endsWith("\n") ? text : `${text}\n`);

// Runs one command and returns its exit code; what it prints goes through `io.write`.
export const runWhatsAppCli = async (argv: readonly string[], io: CliIo): Promise<number> => {
    const [command = "", ...rest] = argv;
    const spec = COMMANDS.get(command);
    if (spec === undefined || rest.length < spec[0]) {
        io.write(line(USAGE));
        return 2;
    }
    const base = await io.gatewayUrl();
    if (base === undefined) {
        io.write("whatsapp: the WhatsApp gateway isn't running yet (no gateway.url). It starts with the sandbox, wait a moment and retry.\n");
        return 2;
    }
    const request = spec[1](rest);
    let res: Response;
    try {
        res = await io.fetch(`${base}${request.path}`, request.init);
    } catch (error) {
        io.write(`whatsapp: the WhatsApp gateway did not answer (${errorMessage(error)}), it may be restarting. Retry in a few seconds.\n`);
        return 2;
    }
    const body = await res.text();
    io.write(line(res.ok ? body : `whatsapp: ${body}`));
    return res.ok ? 0 : 2;
};

export const main = async (): Promise<void> => {
    process.exitCode = await runWhatsAppCli(process.argv.slice(2), {
        gatewayUrl: () => readGatewayUrl("whatsapp"),
        fetch: (url, init) => fetch(url, init),
        write: (text) => void process.stdout.write(text),
    });
};
