import { exec } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fieldsValidator, type Loop, type LoopCheck, type LoopDocument, LoopDocumentSchema } from "@intentic/sandbox-contract";
import type { RoleAnswer } from "../agent/models/role-answer.js";
import { askRoleModel } from "../agent/models/role-model.js";
import type { Services } from "../composition.js";
import { verdictPathIn } from "./loop-brief.js";

const execAsync = promisify(exec);

// Checks completion after each iteration, not by asking the iteration itself: the output document first (cheap), then
// each check in order, short-circuiting on failure. A check that fails to run answers not-done rather than ending the
// loop; only the iteration/spend/stall ceilings do that.

// Same ceiling the automations guard uses: a check is meant to be cheap, not redo the iteration's own work.
const CHECK_TIMEOUT_MS = 60_000;
// Bytes of a check's output kept on the row; enough for the failing assertion, not a full test log.
const DETAIL_TAIL = 500;

export interface StopVerdict {
    readonly done: boolean;
    // Iteration-row detail: the document's reason, a command's output tail, or the judge's ruling, whichever applies.
    readonly detail?: string;
    // Iteration's document, when valid; carried out already parsed rather than re-read by the caller.
    readonly document?: LoopDocument;
}

// Judge's reply as a verdict: must open with DONE or CONTINUE. Off-shape replies are stated as the ask's contract
// (role-answer.ts), not silently accepted, so the loop only acts on a verdict some model actually gave.
const JUDGE_ANSWER = {
    what: `a DONE or CONTINUE verdict`,
    read: (reply: string): StopVerdict => {
        const trimmed = reply.trim();
        return { done: /^done\b/iu.test(trimmed), detail: trimmed.slice(0, DETAIL_TAIL) };
    },
    unusable: ({ detail }: StopVerdict): string | undefined =>
        /^(?:done|continue)\b/iu.test(detail ?? ``) ? undefined : `did not open with DONE or CONTINUE`,
} satisfies RoleAnswer<StopVerdict>;

// Absent, unparseable, or schema/field-invalid output all read as not-done, each in its own words. Field validation
// lets a downstream step trust its promised keys instead of failing one step later with no explanation.
const readDocument = async (services: Services, loop: Loop, iteration: number): Promise<StopVerdict> => {
    if (loop.output.kind === "none") {
        return { done: true };
    }
    const path = verdictPathIn(services.workspace.root, loop.conversationId, iteration);
    let raw: unknown;
    try {
        raw = JSON.parse(await readFile(path, "utf8"));
    } catch {
        return { done: false, detail: `No output file, the iteration ended without writing iteration-${iteration}.json.` };
    }
    const parsed = LoopDocumentSchema.safeParse(raw);
    if (!parsed.success) {
        return { done: false, detail: `Output file did not match the required shape: ${parsed.error.issues[0]?.message ?? "invalid"}.` };
    }
    const document = parsed.data;
    if (loop.output.kind === "json") {
        const fields = fieldsValidator(loop.output.fields).safeParse(document.data ?? {});
        if (!fields.success) {
            const issue = fields.error.issues[0];
            return { done: false, detail: `Output \`data.${issue?.path.join(".") ?? ""}\` is wrong: ${issue?.message ?? "invalid"}.` };
        }
    }
    // Still carried out even when done is false: an exhausted loop should show its last valid document, not a blank.
    return { done: document.done, detail: document.reason.slice(0, DETAIL_TAIL), document };
};

// Judge sees the goal, rubric, and closing report, never the diff (a real limit; a judge needing the tree is a
// `command` check instead). Reply is parsed by its first word; anything unrecognized falls through to not-done.
const askJudge = async (services: Services, loop: Loop, rubric: string, report: string, signal: AbortSignal): Promise<StopVerdict> => {
    const prompt = [
        `You are reviewing whether a coding agent has finished a job. You did none of this work and have no stake in it being done.`,
        ``,
        `THE GOAL:`,
        loop.goal,
        ``,
        `THE RUBRIC, the bar the goal has to clear:`,
        rubric,
        ``,
        `WHAT THE AGENT SAYS IT DID, in its own words:`,
        `---`,
        report.slice(-8_000),
        `---`,
        ``,
        `Answer with one word: DONE or CONTINUE, then one sentence of why.`,
        `Say DONE only if the report shows the rubric is met NOW. Partial work, work described as nearly finished, and work ` +
            `whose verification is not described are all CONTINUE. If the report is too vague to tell, that is CONTINUE.`,
    ].join(`\n`);
    try {
        const { value } = await askRoleModel(services, `loop-verdict`, { prompt, answer: JUDGE_ANSWER }, signal);
        return value;
    } catch (error) {
        // A judge that fails to run reports why, so the row doesn't read as a silent ruling of not-done.
        return { done: false, detail: `Judge did not run: ${error instanceof Error ? error.message : "unknown error"}` };
    }
};

// Runs in the conversation's own tree (an isolated loop's worktree), not the workspace root. Automations guard's runner
// with the sign flipped: zero means done here, not skip. Takes the abort signal so a stop doesn't leave it executing.
const runCommand = async (command: string, cwd: string, signal: AbortSignal): Promise<StopVerdict> => {
    try {
        // Uses the platform's own shell (exec's default), not a hardcoded sh, since the command is the user's own line
        // for whatever machine runs it.
        const { stdout, stderr } = await execAsync(command, { cwd, timeout: CHECK_TIMEOUT_MS, signal });
        const detail = `${stderr}${stdout}`.trim().slice(-DETAIL_TAIL);
        return { done: true, ...(detail !== "" ? { detail } : {}) };
    } catch (error) {
        const { stdout, stderr } = error as { stdout?: string; stderr?: string };
        const detail = `${stderr ?? ""}${stdout ?? ""}`.trim().slice(-DETAIL_TAIL);
        return { done: false, ...(detail !== "" ? { detail } : {}) };
    }
};

const runCheck = (
    services: Services,
    loop: Loop,
    check: LoopCheck,
    params: { readonly cwd: string; readonly report: string; readonly signal: AbortSignal },
): Promise<StopVerdict> =>
    check.kind === "command"
        ? runCommand(check.command, params.cwd, params.signal)
        : askJudge(services, loop, check.rubric, params.report, params.signal);

// Evaluates completion for the iteration that just ended (`cwd` its tree, `report` its closing text, the judge's only
// evidence). The document survives a failed check, so a good report isn't dropped.
export const evaluateStop = async (
    services: Services,
    loop: Loop,
    params: { readonly iteration: number; readonly cwd: string; readonly report: string; readonly signal: AbortSignal },
): Promise<StopVerdict> => {
    const output = await readDocument(services, loop, params.iteration);
    if (!output.done) {
        return output;
    }
    const carried = output.document !== undefined ? { document: output.document } : {};
    for (const check of loop.checks) {
        const verdict = await runCheck(services, loop, check, params);
        if (!verdict.done) {
            return { done: false, ...(verdict.detail !== undefined ? { detail: verdict.detail } : {}), ...carried };
        }
    }
    // Detail prefers the document's own reason over a passing check's stdout tail, when there is one.
    return { done: true, ...(output.detail !== undefined ? { detail: output.detail } : {}), ...carried };
};
