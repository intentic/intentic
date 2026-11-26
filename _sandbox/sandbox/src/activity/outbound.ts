import { type CommandAction, commandActionGate } from "@intentic/extension-manifest";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import { parseJsonOr } from "@intentic/base/json";
import { commandWords } from "../safety/shell-words.js";
import type { Services } from "../composition.js";
import { opt } from "../opt.js";

// What the agent sends out of the sandbox, as the extension that owns the service declared it: a cli card's
// `commandActions` for its command-line tools here, and its `broker.actions` for requests through the credential gateway
// (capabilities/broker/broker-actions.ts). The command guard and the gateway hold each to the owner's action rules
// (guard/outbound-guard.ts), and both record it in Activity in this one row shape. Nothing here knows a provider: a send
// is whatever an enabled extension says it is.
// (2026-11-25) Until then this module matched three chat services' addresses and a fourth's command in shell text, by
// name. Once the chat skills reached their services through the gateway's variables (2026-10-06) no address pattern saw
// their sends, so none of them was recorded or held to a rule.

// How much of a failure's own words survive into the row.
export const ERROR_TAIL = 300;

export interface OutboundCall {
    // The card id the action's key is prefixed with, which is also the row's provider.
    readonly provider: string;
    // The declared action (`message.send`), or `api.call` for a request no declaration covers.
    readonly type: string;
    readonly method: string;
    // The request's path below its service, or a command's words after the program: never a query or a credential.
    readonly endpoint: string;
    readonly channelId?: string;
    readonly content?: string;
}

// One declared command action, with the card id its key is prefixed with.
export interface DeclaredCommand extends CommandAction {
    readonly provider: string;
}

export interface CallOutcome {
    readonly outcome: "ok" | "error";
    readonly error?: string;
}

const programOf = (word: string): string => word.split("/").at(-1) ?? word;

const argumentAt = (args: readonly string[], value: CommandAction["content"]): string | undefined => {
    if (value === undefined || args[value.arg] === undefined) {
        return undefined;
    }
    return value.rest === true ? args.slice(value.arg).join(" ") : args[value.arg];
};

const startsWith = (words: readonly string[], declared: readonly string[]): boolean =>
    words[0] !== undefined && programOf(words[0]) === declared[0] && declared.every((word, index) => index === 0 || words[index] === word);

/**
 * The declared command an invocation in `command` starts with, read with the shell's own quoting (each `;`, `&&` and `|`
 * stage on its own): the first declaration that matches. A command the card's backend gates (`gatedBy: "backend"`) is
 * never one: the outward-action door decides and records it (capabilities/broker/outward-door.ts), so the shell lets a
 * held one reach the door that drafts its approval, and its row is written once. Reads the command text, so a tool
 * reached under another name (an alias, a script around it) is not seen.
 */
export const classifyCommand = (commands: readonly DeclaredCommand[], command: string): OutboundCall | undefined => {
    const declared = commands.filter((entry) => commandActionGate(entry).gatedBy === "sandbox");
    if (declared.length === 0) {
        return undefined;
    }
    for (const words of commandWords(command)) {
        const match = declared.find((entry) => startsWith(words, entry.command));
        if (match === undefined) {
            continue;
        }
        const args = words.slice(match.command.length);
        return {
            provider: match.provider,
            type: match.action,
            // A command has no verb of its own; its row is shown with the one a request doing the same would carry.
            method: match.read === true ? "GET" : "POST",
            endpoint: `/${match.command.slice(1).join("/")}`,
            ...opt("channelId", argumentAt(args, match.channel)),
            ...opt("content", argumentAt(args, match.content)),
        };
    }
    return undefined;
};

/**
 * The refusal a JSON answer carries inside a success, by the two conventions services use: `ok: false` with the reason
 * in `error` or `description`, or a numeric `code` beside a `message`. Undefined for any other answer, JSON or not.
 */
export const refusalIn = (text: string): string | undefined => {
    const parsed = parseJsonOr(text, undefined) as { code?: unknown; message?: unknown; ok?: unknown; error?: unknown; description?: unknown } | null | undefined;
    if (typeof parsed !== "object" || parsed === null) {
        return undefined;
    }
    if (typeof parsed.code === "number" && typeof parsed.message === "string") {
        return parsed.message;
    }
    if (parsed.ok === false) {
        const reason = [parsed.error, parsed.description].find((each) => typeof each === "string");
        return typeof reason === "string" ? reason : "the call was refused";
    }
    return undefined;
};

// A command's outcome: a failed tool call is an error in its own words, and a success may still carry a refusal.
const commandOutcome = (output: string, failed: boolean): CallOutcome => {
    if (failed) {
        return { outcome: "error", error: output.trim().slice(-ERROR_TAIL) };
    }
    const refusal = refusalIn(output);
    return refusal === undefined ? { outcome: "ok" } : { outcome: "error", error: refusal };
};

/**
 * The commands the enabled extensions declare, for a turn's sniffer: none, and a warning, when they cannot be read, since
 * recording never fails the turn it records.
 */
export const sniffedCommands = (services: Pick<Services, "outwardActions" | "logger">): Promise<readonly DeclaredCommand[]> =>
    services.outwardActions().then(
        (actions) => actions.commands,
        (error: Error) => {
            services.logger.warn({ err: error }, "activity: the declared outward commands could not be read; this turn's are not recorded");
            return [];
        },
    );

export interface OutboundSniffer {
    readonly observe: (event: AgentEvent) => void;
    // Record calls whose results never arrived (aborted turns).
    readonly flush: () => void;
}

// One per turn, teed into the turn's frames; appends are fire-and-forget so recording never fails the turn. `turnId`
// (minted in stream-agent.ts) is stamped on every call so the feed folds a turn's sends into its own row. A request
// through the credential gateway is recorded there instead, where its real method, path and body are seen.
export const createOutboundSniffer = (
    services: Pick<Services, "activity" | "logger">,
    turnId: string,
    commands: readonly DeclaredCommand[],
): OutboundSniffer => {
    const pending = new Map<string, OutboundCall>();
    let sessionId: string | undefined;
    const record = (call: OutboundCall, result?: CallOutcome): void => {
        void services.activity
            .append({
                ...call,
                direction: "out",
                turnId,
                ...opt("sessionId", sessionId),
                ...opt("outcome", result?.outcome),
                ...opt("error", result?.error),
            })
            .catch((error: unknown) => services.logger.warn({ err: error }, "activity append failed"));
    };
    return {
        observe: (event) => {
            if (event.kind === "session") {
                sessionId = event.sessionId;
                return;
            }
            if (event.kind === "tool_call" && event.name === "Bash" && event.target !== undefined) {
                const call = classifyCommand(commands, event.target);
                if (call !== undefined) {
                    pending.set(event.id, call);
                }
                return;
            }
            // Only a terminal update settles the call; interim updates (live output snapshots) keep it pending.
            if (event.kind === "tool_call_update" && (event.status === "completed" || event.status === "failed")) {
                const call = pending.get(event.id);
                if (call === undefined) {
                    return;
                }
                pending.delete(event.id);
                const text = event.content?.find((entry) => entry.type === "text")?.text ?? "";
                record(call, commandOutcome(text, event.status === "failed"));
            }
        },
        flush: () => {
            for (const call of pending.values()) {
                record(call);
            }
            pending.clear();
        },
    };
};
