import type { OpenCodeClient, OpenCodeEvent, PermissionRule } from "@opencode/client";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import { displayNameOf } from "@intentic/agent-context/tool-calls";
import type { CommandGuard } from "../../guard/command-guard.js";
import { opt } from "../../opt.js";
import { allowlistRefusal, toolAllowed } from "../../agent/tools/tool-allowlist.js";
import type { ShellRoute } from "./shell/opencode-shell.js";
import { answerVendorAsk, askCwdOf, askProgramOf, VendorToolInputSchema } from "../decorators/vendor-ask.js";

// Who answers OpenCode's permission asks. The server's rules ask about every shell command (opencode-config.ts), and a
// turn in `default` mode asks about edits and fetches as well (DEFAULT_MODE_ASKS); an ask lands on the server's one
// event stream, and this answers it.

// What a person said to one ask a `default`-mode turn put on a card: go ahead, or no with the words the model hears.
export type ApprovalVerdict = { readonly allow: true } | { readonly allow: false; readonly reason: string };

// What answers one session's permission asks: the turn's rulebook gate, where the cards it raises go (the turn's own
// stream, in order with its events), and the turn watchdog's hold, taken while an ask waits on the daemon's answer so a
// card open on a person is not read as a stalled turn.
export interface SessionJudge {
    readonly gate: CommandGuard;
    readonly push: (event: AgentEvent) => void;
    readonly hold: () => () => void;
    // A turn in `default` mode: the per-tool card an ask the rulebook let through goes to, answered by a person. Absent,
    // the rulebook's yes is the answer.
    readonly approve?: (ask: PermissionAsk) => Promise<ApprovalVerdict>;
    // The turn's tool list. Its session's rules already offer only the listed tools (allowlist/opencode-allowlist.ts); what they
    // cannot read is a shell entry narrowed to a command, so every command is asked about and checked here.
    readonly allowedTools?: readonly string[];
    // How the turn's sessions' shell commands run once allowed: in its terminal pane, secrets resolved, output masked
    // (shell/opencode-shell.ts). Absent, the daemon's shell script runs them as written.
    readonly shell?: ShellRoute;
}

// The session rules a `default`-mode turn adds, so the calls the Claude loop's default mode asks a person about reach
// one here too: a file write or edit, and a page fetched. Shell commands are already asked about by the server's rules.
export const DEFAULT_MODE_ASKS: readonly PermissionRule[] = [
    { action: "edit", resource: "*", effect: "ask" },
    { action: "webfetch", resource: "*", effect: "ask" },
];

// Who answers each session's asks while its turn runs, keyed by OpenCode session id, the only key the detached stream
// and a turn's rules share; an ask for a session with none gets the standing yes.
export interface SessionJudges {
    readonly register: (sessionId: string, judge: SessionJudge) => void;
    readonly release: (sessionId: string) => void;
}

export interface PermissionAsk {
    readonly id: string;
    readonly sessionID: string;
    // Which action: `shell`, `edit`, or one this config does not mention.
    readonly kind: string;
    // What the ask is about, as OpenCode names it: the command line, the files, the URL.
    readonly resources: readonly string[];
    // What the classifier reads: the command the metadata names, else the resources the ask is about.
    readonly program: string | undefined;
    // Where it runs: the directory the metadata names, else the one the session runs in.
    readonly cwd?: string;
}

/** The ask an event raises, or undefined for every other event. */
export const permissionAskOf = (event: OpenCodeEvent): PermissionAsk | undefined => {
    if (event.type !== "permission.asked") {
        return undefined;
    }
    const { id, sessionID, action, resources, metadata } = event.data;
    const input = VendorToolInputSchema.parse(metadata);
    // A shell ask's one resource is the command line it would run (checked against 2.0.26).
    return {
        id,
        sessionID,
        kind: action,
        resources,
        program: askProgramOf(input, resources.join(" ")),
        ...opt("cwd", askCwdOf(input, event.location?.directory)),
    };
};

// One answer as OpenCode takes it. A refusal carries its reason, which OpenCode hands the model as the call's failure
// and keeps the turn going. Never `always`, even where no rule is watching: OpenCode 2 turns it into a saved rule for
// the whole project, which every later ask there would then skip, the owner's rulebook included once a turn enforces it.
type PermissionReply = { readonly decision: "once" } | { readonly decision: "reject"; readonly message: string };

// The rulebook reads commands, and only a shell ask is about one: an edit's resources are paths, which read as a command
// would be judged as nonsense.
const RULEBOOK_READS = "shell";

// A shell command off the turn's list: the sentence it is refused with, before the rulebook or a person is asked. A shell
// ask with no command to read is refused too, since nothing could be checked against the list.
const listRefusal = (judge: SessionJudge | undefined, ask: PermissionAsk, program: string | undefined): string | undefined => {
    const list = judge?.allowedTools;
    if (list === undefined || ask.kind !== RULEBOOK_READS) {
        return undefined;
    }
    const call = { name: "Bash", command: program };
    return program !== undefined && toolAllowed(list, call) ? undefined : allowlistRefusal(call, list);
};

/**
 * Answers one permission: a command off the turn's tool list is refused outright; then the owner's rulebook if this
 * session has a judge and the ask is a command, then, for a turn in `default` mode, a person on a per-tool card; the
 * standing yes where neither applies. A hold parks on a card
 * like Codex's: the turn's watchdog is held for the whole consult, and the card's frames reach the turn's stream through
 * the judge. A consult that fails is a refusal: an unanswered ask would stall the turn instead.
 */
export const answerPermission = async (client: OpenCodeClient, judge: SessionJudge | undefined, ask: PermissionAsk): Promise<void> => {
    const program = ask.kind === RULEBOOK_READS ? ask.program : undefined;
    const listed = listRefusal(judge, ask, program);
    if (listed !== undefined) {
        await client.permission.reply({ sessionID: ask.sessionID, requestID: ask.id, decision: "reject", message: listed });
        return;
    }
    // Whether the rulebook already put this call in front of a person: their yes there is the yes, not asked twice.
    let personAsked = false;
    const watched =
        judge === undefined
            ? undefined
            : {
                  ...judge,
                  push: (event: AgentEvent): void => {
                      personAsked ||= event.kind === "permission";
                      judge.push(event);
                  },
              };
    const ruled = await answerVendorAsk(watched, { tool: displayNameOf(ask.kind), program, cwd: ask.cwd, canRefuse: true });
    const answer = ruled.allow && !personAsked && judge?.approve !== undefined ? await judge.approve(ask) : ruled;
    const reply: PermissionReply = answer.allow ? { decision: "once" } : { decision: "reject", message: answer.reason };
    await client.permission.reply({ sessionID: ask.sessionID, requestID: ask.id, ...reply });
};

/**
 * Answers every ask the server raises, once each: one heard live and again in a read-back after a reopened stream
 * (`standing`, which reads every judged session's open asks) is answered by whichever came first. An id is forgotten
 * once its reply went out.
 */
export const permissionAnswers = (judges: ReadonlyMap<string, SessionJudge>) => {
    const answering = new Set<string>();
    const answer = (client: OpenCodeClient, ask: PermissionAsk): void => {
        if (answering.has(ask.id)) {
            return;
        }
        answering.add(ask.id);
        void answerPermission(client, judges.get(ask.sessionID), ask)
            // allow(silent-catch): a failed reply just leaves the ask standing, which the turn's watchdog ends
            .catch(() => {})
            .finally(() => answering.delete(ask.id));
    };
    return {
        answer,
        // The read-back for one server's client, started by calling what this returns.
        standing: (client: OpenCodeClient) => async (): Promise<void> => {
            await Promise.all(
                [...judges.keys()].map(async (sessionID) => {
                    // allow(silent-catch): a session whose asks cannot be read keeps them standing, which its watchdog ends
                    const standing = await client.permission.list({ sessionID }).catch(() => []);
                    for (const request of standing) {
                        const ask = permissionAskOf({ id: request.id, created: Date.now(), type: "permission.asked", data: request });
                        if (ask !== undefined) {
                            answer(client, ask);
                        }
                    }
                }),
            );
        },
    };
};
