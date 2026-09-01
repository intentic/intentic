import { exec } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fieldsValidator, type Loop, type LoopCheck, type LoopDocument, LoopDocumentSchema } from "@intentic/sandbox-contract";
import type { QuickAnswer } from "../agent/quick-answer.js";
import { askQuickModel } from "../agent/quick-model.js";
import type { Services } from "../composition.js";
import { verdictPathIn } from "./loop-brief.js";

const execAsync = promisify(exec);

/* IS THE GOAL MET?, asked after every iteration, and asked by something that is not the iteration.
 *
 * That last clause is the whole design. A loop whose worker declares its own completion stops early and sounds
 * confident doing it: the model that just spent a turn arguing for an approach is the one least able to see
 * that the approach did not work. So the answer is assembled from two kinds of evidence kept deliberately
 * apart, the OUTPUT the iteration wrote (its own word, in a shape the daemon can read rather than interpret)
 * and the CHECKS, each of which is a separate act: a shell command the daemon runs, or a second model that saw
 * none of the reasoning.
 *
 * ALL OF THEM MUST HOLD, and the order they are asked in is both the cheapest and the most sceptical. The
 * output first because it is free, a document that says `done: false` settles the question before a
 * two-minute test run has to answer it, then each check in the order it was configured, short-circuiting on
 * the first that fails. So the expensive checks are only paid for on iterations that claim to be finished.
 *
 * A CHECK THAT FAILS TO RUN NEVER ENDS THE LOOP. A guard command that cannot start, a document that was never
 * written, a judge with no account connected, all of them answer "not done", so the loop continues and a real
 * ceiling (iterations, spend, stall) stops it instead. The alternative is worse in both directions: a check
 * that errors open would call every loop finished on its first iteration, and one that errors closed would
 * burn the whole budget proving a typo in a command.
 */

// The same ceiling the automations guard runs under, for the same reason: a check is meant to be cheap, and one
// that takes longer than this is doing the iteration's work a second time.
const CHECK_TIMEOUT_MS = 60_000;
// How much of a check's own output survives onto the iteration row. Enough for the failing assertion, not the
// whole test log, the transcript is where that lives.
const DETAIL_TAIL = 500;

export interface StopVerdict {
    readonly done: boolean;
    // What to put on the iteration row, the document's reason, the command's output tail, the judge's ruling.
    // The single most-read field in the whole feature: "why did it keep going" and "why did it stop" are the
    // same question.
    readonly detail?: string;
    // The document the iteration wrote, when it wrote a valid one. Carried out of here rather than re-read by
    // the caller because this is where it was already parsed and validated, and because it is what a workflow
    // step hands to the step after it.
    readonly document?: LoopDocument;
}

/* THE JUDGE'S REPLY, AS A VERDICT, and the shape demand is the same one the prompt makes: one word, DONE or
 * CONTINUE, then a sentence.
 *
 * The shape used to be checked HERE and only softly: anything that did not open with "done" fell through to
 * not-done, which is the safe direction but also a silent one. A rung that answered off-shape (a tool-call
 * stand-in from a Gemini rung, a paragraph of reasoning, its own provider's refusal as prose) counted as a
 * ruling the judge never made, and the loop paid a full iteration on it. Stated as the ask's contract instead
 * (quick-answer.ts), the same reply is a rung that did not answer, so the next model in the chain rules and the
 * loop only ever acts on a verdict some model actually gave. Nothing rules ⇒ the catch below says so. */
const JUDGE_ANSWER = {
    what: `a DONE or CONTINUE verdict`,
    read: (reply: string): StopVerdict => {
        const trimmed = reply.trim();
        return { done: /^done\b/iu.test(trimmed), detail: trimmed.slice(0, DETAIL_TAIL) };
    },
    unusable: ({ detail }: StopVerdict): string | undefined =>
        /^(?:done|continue)\b/iu.test(detail ?? ``) ? undefined : `did not open with DONE or CONTINUE`,
} satisfies QuickAnswer<StopVerdict>;

/* Read and validate the iteration's document. Absent, unparseable, schema-violating and field-violating all
 * read the same way, not done, and each says so in its own words, because "the model never wrote the file"
 * and "the model wrote `done: \"yes\"`" have the same remedy only by coincidence.
 *
 * The FIELD validation is what earns the `json` output its name. A step downstream is entitled to assume the
 * keys it was promised are there and hold what they said they would; unchecked here, that assumption fails one
 * step later, in a session with no idea why its input is malformed and no way to ask for it again. Checked
 * here, it is just another iteration, the loop says what was wrong and the next one fixes it.
 */
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
    // A document that says `done: false` is still a VALID document and is still carried out: a step whose loop
    // later runs out of iterations should show the last thing it managed to say, not a blank.
    return { done: document.done, detail: document.reason.slice(0, DETAIL_TAIL), document };
};

/* The judge: a second model, no tools, no transcript, ruling on the goal against the rubric.
 *
 * It is shown the goal, the rubric and the iteration's own closing report, and NOT the diff. That is a real
 * limitation and it is the honest one: the judge runs through the quick-model seam (one prompt, one string, no
 * filesystem), so what it can rule on is whether the work as DESCRIBED meets the bar. That still catches the
 * failure this exists for, an agent that stops while its own account of what it did plainly falls short of the
 * goal, and it does so for the price of one cheap call. A judge that must inspect the tree is a `command`.
 *
 * The reply is parsed by its first word, and the prompt demands that shape. Deliberately strict: a judge whose
 * "DONE" has to be found somewhere inside a paragraph is a judge whose verdict depends on how it phrased
 * itself, and anything unrecognized falls through to not-done, which is the safe direction.
 */
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
        const { value } = await askQuickModel(services, { prompt, answer: JUDGE_ANSWER }, signal);
        return value;
    } catch (error) {
        // A judge that cannot run is not a verdict. Reported as the detail so the row says why the loop is
        // still going, rather than leaving a silent "not done" that looks like the judge ruled.
        return { done: false, detail: `Judge did not run: ${error instanceof Error ? error.message : "unknown error"}` };
    }
};

/* The command check: exit 0 ⇒ satisfied. Run in the conversation's OWN tree, not the workspace root, an
 * isolated loop's work is in its worktree, and a check that ran against /work would be testing the code the
 * loop has not landed yet. This is the automations guard's runner with the sign flipped, and the inversion is
 * the point: there, non-zero means "skip"; here, zero means "stop".
 *
 * IT TAKES THE STOP SIGNAL, which the judge beside it always had and this one silently did not. A run's Stop
 * cuts the turn off where it stands (workflows/workflow-runner.ts explains why it is an abort and not a polite
 * ask), and then the loop settled the iteration, which meant running this, which meant the user watched a
 * stopped run go on executing its test command for up to the full minute below. A killed check answers
 * not-done, exactly as a failing one does, and the loop is ending anyway. */
const runCommand = async (command: string, cwd: string, signal: AbortSignal): Promise<StopVerdict> => {
    try {
        // The platform shell (`/bin/sh -c` everywhere but Windows, where exec uses the system shell): the
        // command is the USER's own line, written for the machine the daemon runs on, a hardcoded `sh` only
        // meant the check could never run at all on a local Windows daemon.
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

/* Evaluate this loop's completion against the iteration that just ended. `cwd` is the conversation's tree,
 * `report` its closing assistant text (the judge's only evidence).
 *
 * THE DOCUMENT SURVIVES A FAILED CHECK. A step that wrote a perfectly good report and then failed its test run
 * has produced something worth keeping and worth showing; dropping it because a later condition said no would
 * leave the row saying only "tests failed", true, and useless to whoever has to decide what the next
 * iteration should do differently.
 */
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
    // Every condition held. The detail is the DOCUMENT's reason when there is one, "the migration is complete
    // and the suite is green" beats the last command's stdout tail, which is what a passing check has to offer.
    return { done: true, ...(output.detail !== undefined ? { detail: output.detail } : {}), ...carried };
};
