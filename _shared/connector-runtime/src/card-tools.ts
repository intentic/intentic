import { readFile } from "node:fs/promises";
import { DAEMON_PORT } from "@intentic/constants";
import type { AgentStoreOptions } from "./refresh-token.js";

// A card's tools, called from the agent's own CLI for that card (2026-11-26): the server the turn's MCP door mounts for
// the card (`contributes.tools.perCard`), which the extension's backend answers holding the card's credential, reached
// through the daemon's `POST /tools/<card>` with the turn's conversation and its proof, the way every agent CLI names
// its turn. The CLI reads and writes the workspace and hands the backend what it read; the credential never reaches the
// shell. The daemon refuses a card the turn was not given.

// What a call carries: JSON, as the MCP request does.
export type CardToolJson = string | number | boolean | null | readonly CardToolJson[] | { readonly [key: string]: CardToolJson | undefined };
export type CardToolArgs = { readonly [key: string]: CardToolJson | undefined };

export interface CardToolText {
    readonly type: "text";
    readonly text: string;
}

// What one call answered: its text, and whether the tool refused or failed (the model's `isError`).
export interface CardToolAnswer {
    readonly text: string;
    readonly isError: boolean;
}

// The door refused the call, or the backend could not be reached: nothing the tool would have done happened.
export class CardToolRefused extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message);
    }
}

interface RpcAnswer {
    readonly result?: { readonly content?: readonly (CardToolText | { readonly type: string })[]; readonly isError?: boolean };
    readonly error?: { readonly message?: string };
}

const textOf = (content: RpcAnswer["result"]): string =>
    (content?.content ?? [])
        .filter((entry): entry is CardToolText => entry.type === "text")
        .map((entry) => entry.text)
        .join("\n");

export interface CardToolOptions extends AgentStoreOptions {
    // How long the call may take before the CLI gives up on its answer; the backend's own deadline is ten minutes.
    readonly timeoutMs?: number;
}

/** One tools/call on the card's server, from the turn's own shell. */
export const callCardTool = async (card: string, tool: string, args: CardToolArgs, options: CardToolOptions = {}): Promise<CardToolAnswer> => {
    const env = options.env ?? process.env;
    const token = (await readFile(env["INTENTIC_AGENT_TOKEN_PATH"] ?? "/run/intentic/agent.token", "utf8")).trim();
    // The route as the contract declares it, never spelled here.
    const { fillRoutePath } = await import("@intentic/sandbox-contract/protocol/raw/route-path");
    const { rawRoutePath } = await import("@intentic/sandbox-contract/protocol/raw/raw-routes");
    const path = fillRoutePath(rawRoutePath("POST /tools/{mount}"), { mount: card });
    const response = await (options.http ?? fetch)(`http://127.0.0.1:${env["SANDBOX_PORT"] ?? DAEMON_PORT}${path}`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(options.timeoutMs ?? 11 * 60_000),
        // The turn's conversation with the proof the daemon believes it by, as every agent CLI sends them.
        headers: {
            "content-type": "application/json",
            "x-intentic-agent": token,
            "x-intentic-conversation": env["INTENTIC_TURN_OWNER"] ?? "",
            "x-intentic-turn-proof": env["INTENTIC_TURN_PROOF"] ?? "",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
    });
    // allow(silent-catch): an unreadable answer is judged by its status alone.
    const raw: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
        // The door's refusal as it writes one (`{ error }`), or the bare status when the body has none.
        const said = raw instanceof Object && "error" in raw ? String(raw.error) : `the daemon answered HTTP ${response.status}`;
        throw new CardToolRefused(said, response.status);
    }
    // SAFETY: a JSON-RPC answer from the backend host (backend-tools.ts), whose every field is optional here and read
    // with a fallback.
    const body = raw instanceof Object ? (raw as RpcAnswer) : undefined;
    if (body?.error !== undefined) {
        throw new CardToolRefused(body.error.message ?? "the card's tools refused the call", 502);
    }
    return { text: textOf(body?.result), isError: body?.result?.isError === true };
};
