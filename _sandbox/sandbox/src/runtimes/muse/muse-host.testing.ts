import { WORKSPACE_ROOT } from "@intentic/constants";
import { type MuseHost, type MuseHostOpener, type MuseLaunch, MspError } from "./muse-host.js";
import type { MuseNotification, MuseParams } from "./muse-wire.js";
import { opt } from "../../opt.js";

// A scripted `muse serve` for the loop's tests: no process, no network. It answers the session and turn commands the
// way Muse Code 1.4.6 does, and plays one script per turn/start, which sends the turn's notifications and can wait for
// the client's next command (an approval decision, an answer) before going on.

export interface FakeTurn {
    readonly sessionId: string;
    readonly turnId: string;
    readonly emit: (method: string, params: MuseParams) => void;
    // Resolves with the params of the next command of this method the client sends.
    readonly next: (method: string) => Promise<MuseParams>;
    // The host dying under the turn.
    readonly exit: (reason: string) => void;
    // Ends the turn with Muse's terminal record.
    readonly complete: (terminal?: string, extra?: MuseParams) => void;
}

export type FakeTurnScript = (turn: FakeTurn) => Promise<void> | void;

export interface FakeMuseOptions {
    readonly turns: readonly FakeTurnScript[];
    // How session/resume answers: Muse still holds the session, or it lost it.
    readonly resume?: "held" | "lost";
    readonly models?: readonly { readonly modelId: string; readonly isDefault?: boolean; readonly variants?: readonly string[] }[];
    // Fails the host's start, as a missing binary or a handshake the host never answered does.
    readonly refuse?: string;
}

export interface FakeMuse {
    readonly open: MuseHostOpener;
    readonly launches: MuseLaunch[];
    readonly commands: { readonly method: string; readonly params: MuseParams }[];
    readonly closed: () => number;
}

export const fakeMuse = (options: FakeMuseOptions): FakeMuse => {
    const launches: MuseLaunch[] = [];
    const commands: { method: string; params: MuseParams }[] = [];
    let closes = 0;
    const open: MuseHostOpener = async (launch) => {
        launches.push(launch);
        if (options.refuse !== undefined) {
            throw new Error(options.refuse);
        }
        const listeners = new Set<(notification: MuseNotification) => void>();
        const waiters = new Map<string, ((params: MuseParams) => void)[]>();
        let exitWith: (reason: string | undefined) => void = () => undefined;
        const exited = new Promise<string | undefined>((resolve) => {
            exitWith = resolve;
        });
        let turns = 0;
        const emit = (method: string, params: MuseParams): void => {
            for (const listener of listeners) {
                listener({ method, params });
            }
        };
        const answer = (method: string, params: MuseParams) => {
            switch (method) {
                case "session/start":
                    return { session: { sessionId: "s1", modelId: params["modelId"] ?? "muse-spark-1.2", providerId: "meta" }, viewCursor: "v:0" };
                case "session/resume": {
                    if (options.resume === "lost") {
                        throw new MspError({ code: -32020, message: "session not found", data: { kind: "sessionNotFound" } });
                    }
                    return { session: { sessionId: params["sessionId"], modelId: "muse-spark-1.2", providerId: "meta" }, viewCursor: "v:0" };
                }
                case "turn/start": {
                    turns += 1;
                    const turnId = `t${String(turns)}`;
                    const script = options.turns[turns - 1];
                    const sessionId = String(params["sessionId"]);
                    const turn: FakeTurn = {
                        sessionId,
                        turnId,
                        emit,
                        next: (wanted) =>
                            new Promise((resolve) => {
                                waiters.set(wanted, [...(waiters.get(wanted) ?? []), resolve]);
                            }),
                        exit: (reason) => exitWith(reason),
                        complete: (terminal = "completed", extra = {}) =>
                            emit("turn/completed", { sessionId, turnId, terminal, viewCursor: "v", sourceRange: {}, ...extra }),
                    };
                    setTimeout(() => {
                        void (async () => {
                            emit("turn/started", { sessionId, turnId, commandId: "c", viewCursor: "v", sourceRange: {} });
                            await script?.(turn);
                        })();
                    }, 0);
                    return { commandId: "c", disposition: "started", startedNewTurn: true, status: "accepted", turnId };
                }
                default:
                    return { status: "accepted" };
            }
        };
        const host: MuseHost = {
            version: "1.4.6",
            request: async (method, _params, schema) =>
                schema.parse(
                    method === "model/list"
                        ? {
                              providerId: "meta",
                              source: "providerCatalog",
                              profileId: "tbh",
                              models: (options.models ?? []).map((model) => ({
                                  modelId: model.modelId,
                                  displayLabel: model.modelId,
                                  providerId: "meta",
                                  contextLimit: 200_000,
                                  isDefault: model.isDefault === true,
                                  description: null,
                                  ...opt("variants", model.variants),
                              })),
                          }
                        : {},
                ),
            command: async (method, params, schema) => {
                commands.push({ method, params });
                const waiting = waiters.get(method)?.shift();
                waiting?.(params);
                return schema.parse(answer(method, params));
            },
            listen: (listener) => {
                listeners.add(listener);
                return () => listeners.delete(listener);
            },
            exited,
            close: async () => {
                closes += 1;
                exitWith(undefined);
            },
        };
        return host;
    };
    return { open, launches, commands, closed: () => closes };
};

// One transcript item event, as the host would send it.
export const museItem = (turn: FakeTurn, method: "item/started" | "item/updated" | "item/completed", fields: MuseParams): void =>
    turn.emit(method, { sessionId: turn.sessionId, viewCursor: "v", sourceRange: {}, item: { revision: 1, turnId: turn.turnId, ...fields } });

// An approval Muse raised for a shell command, with the choices 1.4.6 offers.
export const museShellApproval = (turn: FakeTurn, approvalId: string, command: string): void =>
    turn.emit("approval/requested", {
        approvalId,
        sessionId: turn.sessionId,
        turnId: turn.turnId,
        itemId: approvalId,
        taskId: approvalId,
        toolCallId: "call_1",
        toolName: "bash",
        rawArgs: JSON.stringify({ command, description: "Run it" }),
        judgeEscalated: false,
        protectedWrite: false,
        viewCursor: "v",
        sourceRange: {},
        availableChoices: [
            { choiceId: "allow_once", decision: "approved", label: "Allow once", scope: "once" },
            { choiceId: "allow_local_prefix", decision: "approvedPolicyAmendment", label: "Always allow", scope: "localPersistent" },
            { choiceId: "abort", decision: "abort", label: "Reject", scope: "once", acceptsFeedback: true },
        ],
        currentRequirementId: { approvalId, sourceIndex: 0 },
        subject: { kind: "shell", command, workspaceRoot: WORKSPACE_ROOT },
    });
