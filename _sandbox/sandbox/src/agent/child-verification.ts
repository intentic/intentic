import type { AgentEvent, SubagentVerification, ToolCallStatus } from "@intentic/sandbox-contract";
import { createFrameLedger, type FrameLedger, trackedCall } from "./agent-verification.js";

/* DID THE CHILD PROVE ANYTHING? — the verdict that rides back with a child's report.
 *
 * WORK THAT MERGES INTO THE MAIN TREE PASSES A GATE (agents/land.ts refuses a patch that will not apply). A
 * CLAIM THAT MERGES INTO THE PARENT'S CONTEXT PASSED NONE. A child says "done, the parser now handles the
 * empty case" and that sentence becomes the parent's premise: the parent plans on it, reports it upward, and
 * lands on it. Nothing between the two asked whether anything checked it.
 *
 * The daemon already knew. agent-verification.ts holds the ledger that answers it, edits against the checks
 * that ran after them, but it was wired one way only: as a `turn.ending` RULE, in the Claude arm's Stop hook
 * (rules/turn-ending.ts). Three things follow from that, and each is a hole this module fills:
 *
 *   · it fires for the PARENT'S turn, so an SDK child's unverified edits are noticed at the parent's Stop,
 *     which is after the parent has read the report and acted on it;
 *   · it is SDK hooks, so a child on Codex, Grok, Gemini, Cursor or an ACP agent, which is the entire point
 *     of the spawn door (children/children.ts), is not covered at all;
 *   · its output is a NUDGE BACK TO THE MODEL that produced the work. Advice to the author is not evidence
 *     for the reader, and there was nothing the reader could read.
 *
 * SO THE LEDGER IS FED FROM FRAMES, not from hooks. Every runtime's adapter normalizes its native stream into
 * the same `tool_call` / `tool_call_update` vocabulary (agent/tool-calls.ts: `category`, `target`,
 * `locations`, `status`, `content`), which is the one seam every provider in this daemon already passes
 * through, and that is why a Cursor child gets the same verdict a Claude one does. The feeder itself lives
 * next to the ledger it fills (agent-verification.ts, createFrameLedger), because the parent turn now wants
 * exactly the same thing for itself; what stays HERE is the only part that is genuinely about children, which
 * is working out whose call a frame belongs to.
 *
 * ONE LEDGER PER CHILD, KEYED BY THE CHILD'S OWN id — the spawning tool call's id for an SDK child, the
 * conversation id for a spawned one, which is the id its record, its card and the wait tool already use
 * (subagents.ts). Its life is the record's: subagents.ts forgets it when the record is swept.
 *
 * WHAT IT REFUSES TO DO is claim more than it saw. `no-code` is stated rather than left silent, because a
 * research child that edited nothing has a report this mechanism cannot speak to at all, and silence there
 * would read as approval. And a passing check is never upgraded into "the repo is green": the standing names
 * the command that spoke, so a reader can see it was one test file. */

/* Per-child ledgers, and who owns each tool call still waiting to land. The second map is what makes a
 * `tool_call_update` attributable: it carries the call's id and its outcome, but not the child's. What the
 * call WAS lives inside the child's own ledger (createFrameLedger); only the ownership is this module's, and
 * only this module needs it, because a turn has one ledger and nothing to route. */
const ledgers = new Map<string, FrameLedger>();
const callOwner = new Map<string, string>();

// How many paths ride on the wire and into the parent's context. A child that touched forty files has said
// what it needs to say in the first few; the record itself is the transcript.
const PATHS_ON_THE_WIRE = 8;
// A command is a line, not a script. Long enough for `pnpm -C _sandbox/sandbox test src/agent/x.test.ts`.
const CHECK_CHARS = 200;

/* The child's ledger, OPENED at its first tracked call rather than when that call succeeds, which is what
 * keeps `undefined` meaning one thing only: the daemon saw nothing from this child. An agent whose every edit
 * was refused has still been watched, and its standing is `no-code` — it changed no code — where "nothing
 * seen" would leave the roster silent about an agent that plainly worked. */
const ledgerOf = (child: string): FrameLedger => {
    const existing = ledgers.get(child);
    if (existing !== undefined) {
        return existing;
    }
    const fresh = createFrameLedger();
    ledgers.set(child, fresh);
    return fresh;
};

// A call that is already terminal in the frame that opened it (an adapter reporting a fast tool in one go) is
// settled by the ledger on the same line, so nothing is left to route and no ownership is filed for it.
const settled = (status: ToolCallStatus | undefined): boolean => status === "completed" || status === "failed";

/* ONE FRAME OF A CHILD'S WORK. `child` is undefined for the frames that cannot name their own owner (a
 * `tool_call_update` carries only the call id), which is exactly why the ownership map exists: the update is
 * routed to whoever the opening `tool_call` was attributed to, and dropped when that is nobody.
 *
 * Called for a child's frames only: agent.ts feeds the SDK children of a Claude turn (frames carrying a
 * `parentToolUseId`), children/children.ts feeds a spawned child's own turn on whatever provider runs it. A
 * frame belonging to no child never reaches here, so an ordinary turn pays a map lookup and nothing else.
 *
 * The classification is PEEKED at before the ledger is opened, and that order is the point: a child that used
 * nothing but Read must stay unseen rather than become `no-code`, which is a verdict about a different kind of
 * agent entirely. */
export const noteChildWork = (event: AgentEvent, child: string | undefined): void => {
    if (event.kind === "tool_call") {
        if (child === undefined || trackedCall(event) === undefined) {
            return;
        }
        ledgerOf(child).note(event);
        if (!settled(event.status)) {
            callOwner.set(event.id, child);
        }
        return;
    }
    if (event.kind === "tool_call_update") {
        const owner = callOwner.get(event.id);
        if (owner === undefined) {
            return;
        }
        ledgers.get(owner)?.note(event);
        if (settled(event.status)) {
            callOwner.delete(event.id);
        }
    }
};

/** Where a child's work stands right now, as the wire says it. Undefined ⇒ nothing of this child was ever
 *  seen (it used no tools, or it is not one of ours), which is not the same as `no-code` and must not be
 *  rendered as a verdict. Peeks: the ledger lives as long as the record does (`forgetChild`). */
export const childVerification = (child: string): SubagentVerification | undefined => {
    const ledger = ledgers.get(child);
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

/** The ledger goes when the record it belongs to does (subagents.ts sweeps on every list and every write), so
 *  a sandbox that ran ten thousand children holds ten thousand of nothing. */
export const forgetChild = (child: string): void => {
    ledgers.delete(child);
    for (const [id, owner] of callOwner) {
        if (owner === child) {
            callOwner.delete(id);
        }
    }
};

/* WHAT THE PARENT IS TOLD, IN ITS OWN CONTEXT, and the deliberate silence in it: only the two states that
 * carry a warning are spoken.
 *
 * The other two ride the wire, where the roster row, the card and the wait tool's answer all carry the whole
 * verification object for anyone who asks. But an Explore child that read forty files and edited nothing is
 * the commonest child there is, and a line saying so appended to every one of its reports is a line the model
 * learns to skip — and it would be spending the parent's context to say that a mechanism about code edits has
 * no opinion about a research answer. Silence when there is nothing to warn about is the same discipline the
 * Stop nudge keeps (agent-verification.ts), for the same reason. */
export const childVerificationNote = (verification: SubagentVerification): string | undefined => {
    const files = verification.paths ?? [];
    // Three named and the rest counted: enough for the reader to know WHERE, short enough to stay one line.
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

// Tests drive the feeder through its real entry points, so they need a way back to empty between cases.
export const resetChildVerification = (): void => {
    ledgers.clear();
    callOwner.clear();
};
