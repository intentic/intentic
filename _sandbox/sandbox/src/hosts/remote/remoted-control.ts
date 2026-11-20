import { request } from "node:http";
import { join } from "node:path";
import { DEVICE_SOCKET_DIR } from "@intentic/sandbox-contract/browser-wire";
import { RemoteAllowSchema, RemoteMonitorSchema } from "@intentic/sandbox-contract/schemas/device-remote";
import type { RemoteTerminal } from "@intentic/sandbox-contract/schemas/remote-access";
import { parseJsonWith } from "@intentic/base/json";
import { z } from "zod";
import type { RemoteInfo } from "./remote-device.js";

/* remoted's control routes, asked on the socket netd serves for a connected device (`<DEVICE_SOCKET_DIR>/<uplink
   id>.sock`), each connection one stream down its uplink: `GET /info`, `GET /terminals`, `POST /terminals`, `DELETE
   /terminals/<session>`, `POST /viewers/drop` (castd's meaning). They carry no token: netd serves that socket to the
   daemon alone (0600), and never relays a viewer's path to one of them. */

export interface RemotedAnswer {
    readonly status: number;
    readonly body: string;
}

// One request on the device's socket, undefined for no answer at all (no uplink, a hang past its deadline). The only body
// the daemon sends is a terminal's ask.
export type RemotedAsk = (socket: string, method: "GET" | "POST" | "DELETE", path: string, body?: TerminalAsk) => Promise<RemotedAnswer | undefined>;

const ASK_MS = 5_000;

const askRemoted: RemotedAsk = (socket, method, path, body) =>
    new Promise((resolve) => {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const headers =
            payload === undefined
                ? { host: "remoted" }
                : { host: "remoted", "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) };
        const asked = request({ socketPath: socket, method, path, timeout: ASK_MS, headers }, (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
            response.on("error", () => resolve(undefined));
        });
        asked.on("timeout", () => asked.destroy());
        asked.on("error", () => resolve(undefined));
        asked.end(payload);
    });

// remoted's `GET /info` (its http.rs: `{version, monitors, environments, encoders, allow, paused}`), read as remoteStart
// answers it (the contract's RemoteStartResult): what the daemon does not read is dropped, a monitor's included, so a
// newer remoted saying more of one is still read.
const InfoSchema = z
    .object({
        version: z.string(),
        allow: RemoteAllowSchema.strip(),
        monitors: z.array(RemoteMonitorSchema.strip()),
        environments: z.array(z.string()),
    })
    .transform(({ version, allow, monitors, environments }): RemoteInfo => ({ version, allow, monitors, environments }));

// A terminal as remoted lists it; `createdAt` read as ms since the epoch whether it came as a number or a date.
const TerminalSchema = z.object({
    session: z.string(),
    title: z.string().default(""),
    environment: z.string().default(""),
    createdAt: z.union([z.number(), z.string().transform((date) => Date.parse(date) || 0)]).default(0),
    viewers: z.number().default(0),
});
const TerminalsSchema = z.union([z.array(TerminalSchema), z.object({ terminals: z.array(TerminalSchema) }).transform((listed) => listed.terminals)]);

export interface TerminalAsk {
    readonly session: string;
    readonly environment?: string | undefined;
    readonly shell?: string | undefined;
    readonly cwd?: string | undefined;
    readonly cols: number;
    readonly rows: number;
}

// Why a terminal could not be made, for the person: remoted's own words where it gave some.
export class RemotedRefused extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
        this.name = "RemotedRefused";
    }
}

export interface RemotedControl {
    readonly info: () => Promise<RemoteInfo | undefined>;
    readonly terminals: () => Promise<RemoteTerminal[] | undefined>;
    // The terminal remoted made; throws RemotedRefused when it would not.
    readonly openTerminal: (asked: TerminalAsk) => Promise<RemoteTerminal>;
    // False when remoted holds no such terminal.
    readonly closeTerminal: (session: string) => Promise<boolean>;
    // Ends every viewer's socket (or only the read-write ones), and has remoted refuse every such token minted before now.
    readonly dropViewers: (asked: { readonly reason: string; readonly readWrite?: boolean }) => Promise<boolean>;
}

// The words a refusal carries: a JSON `error`/`message`, else the body as it came, else the status.
const refusalOf = (answer: RemotedAnswer | undefined): string => {
    if (answer === undefined) {
        return "the device's remote access did not answer";
    }
    const said = parseJsonWith(answer.body, z.object({ error: z.string().optional(), message: z.string().optional() }));
    return said?.error ?? said?.message ?? (answer.body.trim() === "" ? `remoted answered ${answer.status}` : answer.body.trim().slice(0, 300));
};

export const socketOf = (device: string, dir: string = DEVICE_SOCKET_DIR): string => join(dir, `${device}.sock`);

export const remotedControl = (socket: string, ask: RemotedAsk = askRemoted): RemotedControl => ({
    info: async () => {
        const answer = await ask(socket, "GET", "/info");
        return answer?.status === 200 ? parseJsonWith(answer.body, InfoSchema) : undefined;
    },
    terminals: async () => {
        const answer = await ask(socket, "GET", "/terminals");
        return answer?.status === 200 ? parseJsonWith(answer.body, TerminalsSchema) : undefined;
    },
    openTerminal: async (asked) => {
        const answer = await ask(socket, "POST", "/terminals", asked);
        const made = answer !== undefined && (answer.status === 200 || answer.status === 201) ? parseJsonWith(answer.body, TerminalSchema) : undefined;
        if (made === undefined) {
            throw new RemotedRefused(answer?.status ?? 0, refusalOf(answer));
        }
        return made;
    },
    closeTerminal: async (session) => {
        const answer = await ask(socket, "DELETE", `/terminals/${encodeURIComponent(session)}`);
        return answer !== undefined && answer.status >= 200 && answer.status < 300;
    },
    dropViewers: async ({ reason, readWrite }) => {
        const query = new URLSearchParams({ reason });
        if (readWrite === true) {
            query.set("read_write", "1");
        }
        return (await ask(socket, "POST", `/viewers/drop?${query.toString()}`))?.status === 200;
    },
});
