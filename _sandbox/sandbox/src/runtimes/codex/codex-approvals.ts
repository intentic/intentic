import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { PermissionMode } from "@intentic/sandbox-contract/schemas/agent";
import type { ProgramAsk } from "@intentic/sandbox-contract/events/requests";
import type { TurnHooks } from "../../agent/providers/agent-request.js";
import type { ParkedCards } from "../../conversations/actor/parked-cards.js";
import { type CommandGuard, type GuardOutcome, vendorSubject } from "../../guard/command-guard.js";
import { opt } from "../../opt.js";
import type { CodexEvent, CodexFileChange } from "./codex-app-server.js";
import type { CodexGateRecord } from "./codex-hooks.js";

// How a Codex turn answers the approvals app-server raises, by the permission mode the turn was sent in. Every turn runs
// under approvalPolicy "untrusted" (the command gate always enforces), so Codex asks about every patch and every command
// off its own known-safe list. The turn's own PreToolUse hook has already put each call to the gate (codex-hooks.ts), so
// on the turn's own thread a request is answered from that record: a call the gate allowed is not asked about again, and
// one the gate never answered (its hook failed, and Codex ran on regardless) is refused. A subagent's thread has no
// connected gate (Codex leaves its MCP servers unconnected, so its hooks fail), so its requests are judged here as they
// always were, and its known-safe commands run unseen.
// - ask: `default` mode, the one that asks a person. Each command the gate lets through, each patch and each widening of
//   the sandbox parks on the same per-tool card the Claude loop raises.
// - auto: every other mode. The gate still judges commands; patches and permissions are granted, the container being
//   the isolation boundary.
// - plan: a planning phase. It runs read-only, so a patch is declined and a permission request keeps its network half
//   only; commands answer to the gate as ever.
export type CodexPosture = "ask" | "auto" | "plan";

export const codexPosture = (mode: PermissionMode | undefined, planning: boolean): CodexPosture => {
    if (planning) {
        return "plan";
    }
    return mode === "default" ? "ask" : "auto";
};

// What a per-tool card needs from the run: where cards park, the answer a restart restored, and the tools the person
// said not to ask about again. `always` is the run's, so a planning phase's answer still holds while executing.
export interface OwnerApprovals {
    readonly cards: Pick<ParkedCards, "create">;
    readonly conversationId?: string;
    readonly signal: AbortSignal;
    readonly restoredGrant?: TurnHooks["restoredGrant"];
    readonly always: Set<string>;
}

// One card's question, in the permission frame's own fields.
interface ToolAsk {
    readonly toolName: string;
    readonly displayName: string;
    readonly title: string;
    readonly reason?: string;
    readonly path?: string;
    readonly program?: ProgramAsk;
}

interface OwnerAnswer {
    readonly allow: boolean;
    // The person said not to ask again: Codex is told to remember it for the thread too.
    readonly remember: boolean;
}

const ALLOWED_ALWAYS: OwnerAnswer = { allow: true, remember: true };

// The per-tool card, as the Claude loop's askOwner raises it: parked until somebody presses a button, the resolved
// frame going out before the answer so a replayed transcript freezes the card.
async function* askOwner(ask: ToolAsk, owner: OwnerApprovals): AsyncGenerator<AgentEvent, OwnerAnswer> {
    if (owner.always.has(ask.toolName)) {
        return ALLOWED_ALWAYS;
    }
    // A card answered before a restart, consumed by the resumed turn's re-ask so it does not ask twice.
    const restored = owner.restoredGrant?.(ask.toolName);
    if (restored !== undefined) {
        if (restored.always) {
            owner.always.add(ask.toolName);
        }
        return { allow: true, remember: restored.always };
    }
    const { id, wait } = owner.cards.create(
        "permission",
        { kind: "permission", requestId: "", decision: "deny", feedback: "The turn was cancelled before you answered." },
        owner.conversationId,
    );
    yield {
        kind: "permission",
        requestId: id,
        toolName: ask.toolName,
        title: ask.title,
        displayName: ask.displayName,
        ...opt("reason", ask.reason),
        ...opt("path", ask.path),
        ...opt("program", ask.program),
        alwaysLabel: `Don't ask again for ${ask.displayName}`,
    };
    const { reply, resolved } = await wait(owner.signal);
    yield resolved;
    if (reply.decision === "deny") {
        return { allow: false, remember: false };
    }
    const remember = reply.decision === "always" || reply.decision === "everything";
    if (remember) {
        owner.always.add(ask.toolName);
    }
    return { allow: true, remember };
}

// How much of a command the card shows; the gate's own card clips the same way, with its spans.
const SHOWN_PROGRAM = 2_000;

const programOf = (command: string): ProgramAsk => ({
    text: command.slice(0, SHOWN_PROGRAM),
    language: "bash",
    truncated: command.length > SHOWN_PROGRAM,
    spans: [],
});

// The gate's verdict, and whether reaching it already put a card in front of a person.
async function* consultNoting(gate: CommandGuard, command: string, cwd: string | undefined): AsyncGenerator<AgentEvent, { outcome: GuardOutcome; asked: boolean }> {
    const consult = gate.consult(command, vendorSubject("Bash"), { cwd });
    let asked = false;
    for (let step = await consult.next(); ; step = await consult.next()) {
        if (step.done === true) {
            return { outcome: step.value, asked };
        }
        asked ||= step.value.kind === "permission";
        yield step.value;
    }
}

// What the turn's hooks recorded for the call an approval is about: absent where no hooks run (a test, a bench run), a
// lookup by Codex's item id where they do.
export type HookRecords = ((id: string) => CodexGateRecord | undefined) | undefined;

// The gate's answer to this request's call from the hook, or undefined when it must be judged here (no hooks, or a
// subagent's thread). A call the hooks never answered reads as refused: that hook failed open.
const hookedVerdict = (records: HookRecords, request: { readonly item_id?: string; readonly subagent?: true }): { outcome: GuardOutcome; asked: boolean } | undefined => {
    if (records === undefined || request.subagent === true) {
        return undefined;
    }
    const record = request.item_id === undefined ? undefined : records(request.item_id);
    return record?.allowed === true
        ? { outcome: { allow: true }, asked: record.asked }
        : { outcome: { allow: false, reason: "the policy gate never answered this call" }, asked: false };
};

// A command: the gate first, at every posture, since the owner's rules hold whatever the mode; then, in `ask`, the
// person, unless the gate's own card already put this very command to them. A refusal declines rather than cancels,
// since Codex's `cancel` interrupts the whole turn and a refused command should just make the agent try something else.
export async function* answerCommand(
    request: Extract<CodexEvent, { type: "command_approval.requested" }>,
    posture: CodexPosture,
    gate: CommandGuard | undefined,
    owner: OwnerApprovals,
    records?: HookRecords,
): AsyncGenerator<AgentEvent> {
    // Codex's reply has room for a yes or a no only, so an allowed install's note reaches the chat as its notice alone.
    const judged =
        hookedVerdict(records, request) ??
        (gate === undefined ? { outcome: { allow: true } as const, asked: false } : yield* consultNoting(gate, request.command, request.cwd));
    if (!judged.outcome.allow || posture !== "ask" || judged.asked) {
        request.respond(judged.outcome.allow);
        return;
    }
    const answer = yield* askOwner(
        { toolName: "Bash", displayName: "Run command", title: "Run this command?", ...opt("reason", request.reason), program: programOf(request.command) },
        owner,
    );
    request.respond(answer.allow, answer.remember);
}

// A patch, put to the person by the files it touches; Codex named them on the item that opened before the request.
export async function* answerFileChange(
    request: Extract<CodexEvent, { type: "file_change_approval.requested" }>,
    posture: CodexPosture,
    changes: readonly CodexFileChange[] | undefined,
    owner: OwnerApprovals,
    records?: HookRecords,
): AsyncGenerator<AgentEvent> {
    // A patch the gate never saw is refused, whatever the posture: its hook failed open.
    if (hookedVerdict(records, request)?.outcome.allow === false) {
        request.respond(false);
        return;
    }
    if (posture !== "ask") {
        request.respond(posture === "auto");
        return;
    }
    const files = (changes ?? []).map((change) => change.path);
    const answer = yield* askOwner(
        {
            toolName: "Edit",
            displayName: "Edit files",
            title: files.length === 0 ? "Apply this patch?" : `Apply this patch to ${files.join(", ")}?`,
            ...opt("reason", request.reason),
            ...opt("path", files.length === 1 ? files[0] : undefined),
        },
        owner,
    );
    request.respond(answer.allow, answer.remember);
}

// A widening of the sandbox: the network or filesystem reach a command needs beyond the turn's sandbox policy.
export async function* answerPermissions(
    request: Extract<CodexEvent, { type: "permissions_approval.requested" }>,
    posture: CodexPosture,
    owner: OwnerApprovals,
): AsyncGenerator<AgentEvent> {
    if (posture !== "ask") {
        request.respond(posture === "auto" ? "all" : "network");
        return;
    }
    const answer = yield* askOwner(
        {
            toolName: "Sandbox",
            displayName: "Widen the sandbox",
            title: request.writes ? "Let Codex write outside its sandbox for this turn?" : "Let Codex reach the network for this turn?",
            ...opt("reason", request.reason),
        },
        owner,
    );
    request.respond(answer.allow ? "all" : "none");
}
