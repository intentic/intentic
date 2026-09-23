import type { AgentEvent, SubagentVerification, ToolCallStatus } from "@intentic/sandbox-contract";
import type { ConversationActors } from "../../agents/actor/conversation-actors.js";
import type { Holding } from "../../agents/actor/conversation-holdings.js";
import { createFrameLedger, type FrameLedger, trackedCall } from "../verification/agent-verification.js";
import { ROSTER } from "./subagent-roster.js";

// Whether a child's report is checked: fed from every provider's own tool_call/tool_call_update frames, not hooks, so
// Codex, Grok, Cursor and ACP children are covered too. One ledger per child id, alive as long as its record. `no-code`
// is stated explicitly, since silence would read as approval.

// Per-child ledgers, plus which child owns each pending call id, since an update frame carries no child id itself. Both
// held with the child's roster record, by the conversation holding it, and filed about the child; a child with no record
// yet (an unlabelled task) has its ledger in the conversationless bucket until the roster sweeps it.
const LEDGERS: Holding<FrameLedger> = { name: "child ledgers" };
const CALLS: Holding<string> = { name: "child calls" };

// How many paths ride onto the wire; a child that touched forty files has said what matters in the first few.
const PATHS_ON_THE_WIRE = 8;
// A command is a line, not a script; long enough for a typical `pnpm test <path>` invocation.
const CHECK_CHARS = 200;

// Opened at the first tracked call, not on success, so undefined always means nothing was seen; an agent whose edits
// were all refused still gets `no-code`, not silence.
const ledgerOf = (actors: Pick<ConversationActors, "holdings">, child: string, holder: string | undefined): FrameLedger => {
    const ledgers = actors.holdings(LEDGERS);
    const existing = ledgers.get(child);
    if (existing !== undefined) {
        return existing;
    }
    const fresh = createFrameLedger();
    ledgers.hold(holder, child, fresh, child);
    return fresh;
};

// A call already terminal in its own opening frame needs no routing entry.
const settled = (status: ToolCallStatus | undefined): boolean => status === "completed" || status === "failed";

// `child` is undefined for update frames (they carry no owner), routed instead via the ownership map. Classification is
// checked before opening the ledger, so a child using only Read stays unseen rather than becoming `no-code`.
export const noteChildWork = (actors: Pick<ConversationActors, "holdings">, event: AgentEvent, child: string | undefined): void => {
    const calls = actors.holdings(CALLS);
    if (event.kind === "tool_call") {
        if (child === undefined || trackedCall(event) === undefined) {
            return;
        }
        const holder = actors.holdings(ROSTER).holder(child);
        ledgerOf(actors, child, holder).note(event);
        if (!settled(event.status)) {
            calls.hold(holder, event.id, child, child);
        }
        return;
    }
    if (event.kind === "tool_call_update") {
        const owner = calls.get(event.id);
        if (owner === undefined) {
            return;
        }
        actors.holdings(LEDGERS).get(owner)?.note(event);
        if (settled(event.status)) {
            calls.drop(event.id);
        }
    }
};

/** Undefined means nothing of this child was ever seen (no tools used, or not ours); distinct from `no-code` and must not render as a verdict. */
export const childVerification = (actors: Pick<ConversationActors, "holdings">, child: string): SubagentVerification | undefined => {
    const ledger = actors.holdings(LEDGERS).get(child);
    if (ledger === undefined) {
        return undefined;
    }
    const standing = ledger.standing();
    return {
        state: standing.state,
        ...(standing.paths.length > 0 ? { paths: standing.paths.slice(0, PATHS_ON_THE_WIRE) } : {}),
        ...(standing.check !== undefined ? { check: standing.check.slice(0, CHECK_CHARS) } : {}),
    };
};

/** Goes when the record it belongs to does (subagents.ts sweeps on every list and write), so it costs nothing after. */
export const forgetChild = (actors: Pick<ConversationActors, "holdings">, child: string): void => {
    actors.holdings(LEDGERS).drop(child);
    const calls = actors.holdings(CALLS);
    for (const [id, owner] of calls.entries()) {
        if (owner === child) {
            calls.drop(id);
        }
    }
};

// Only unproven/failing are spoken; verified/no-code stay silent, since an Explore child that edited nothing is the
// common case, and repeating that costs the parent's context for nothing.
export const childVerificationNote = (verification: SubagentVerification): string | undefined => {
    const files = verification.paths ?? [];
    // Three named and the rest counted: enough to say where, short enough to stay one line.
    const named = files.length === 0 ? "the files it changed" : `${files.slice(0, 3).join(", ")}${files.length > 3 ? `, +${files.length - 3} more` : ""}`;
    if (verification.state === "unproven") {
        return (
            `Verification: UNPROVEN. This agent changed ${files.length} code ${files.length === 1 ? "file" : "files"} (${named}) and no ` +
            `check passed after its last edit. Its report is a claim about work nothing has tested: check it before you build on it.`
        );
    }
    if (verification.state === "failing") {
        return (
            `Verification: FAILING. The last check after this agent's edits did not pass: \`${verification.check ?? "a check"}\`. ` +
            `Its report describes work that is currently broken in ${named}.`
        );
    }
    return undefined;
};

// Tests drive the feeder through its real entry points and need a way back to empty between cases.
export const resetChildVerification = (actors: Pick<ConversationActors, "holdings">): void => {
    actors.holdings(LEDGERS).clear();
    actors.holdings(CALLS).clear();
};
