import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { type Loop, LOOP_DIR } from "@intentic/sandbox-contract";
import { z } from "zod";
import { askQuickModel } from "../agent/quick-model.js";
import type { Services } from "../composition.js";

const execFileAsync = promisify(execFile);

/* IS THE GOAL MET? — asked after every iteration, and asked by something that is not the iteration.
 *
 * That last clause is the whole design. A loop whose worker declares its own completion stops early and sounds
 * confident doing it: the model that just spent a turn arguing for an approach is the one least able to see
 * that the approach did not work. So each of the three checks below is a SEPARATE act from the work — a shell
 * command the daemon runs, a file the daemon reads and validates, or a second model that saw none of the
 * reasoning. The contract's LoopStop orders them by how much of the answer you can believe, and this module is
 * where that ordering becomes real.
 *
 * A check that FAILS TO RUN never ends the loop. A guard command that cannot start, a verdict file that was
 * never written, a judge with no account connected — all of them answer "not done", so the loop continues and
 * a real ceiling (iterations, spend, stall) stops it instead. The alternative is worse in both directions: a
 * check that errors open would call every loop finished on its first iteration, and one that errors closed
 * would burn the whole budget proving a typo in a command.
 */

// The same ceiling the automations guard runs under, for the same reason: a check is meant to be cheap, and one
// that takes longer than this is doing the iteration's work a second time.
const CHECK_TIMEOUT_MS = 60_000;
// How much of a check's own output survives onto the iteration row. Enough for the failing assertion, not the
// whole test log — the transcript is where that lives.
const DETAIL_TAIL = 500;

// What a `claim` iteration writes. `evidence` is optional because a model that has nothing to point at should
// say so by omitting it rather than by inventing a sentence; `reason` is not, because it is what the next
// iteration reads first.
const LoopVerdictSchema = z.object({ done: z.boolean(), reason: z.string(), evidence: z.string().optional() });

export interface StopVerdict {
    readonly done: boolean;
    // What to put on the iteration row — the guard's output, the claim's reason, the judge's ruling. The single
    // most-read field in the whole feature: "why did it keep going" and "why did it stop" are the same question.
    readonly detail?: string;
}

// Read and validate one iteration's verdict file. Absent, unparseable or schema-violating all read the same
// way — not done — and each says so in its own words, because "the model never wrote the file" and "the model
// wrote `done: "yes"`" are different problems with the same remedy only by coincidence.
const readClaim = async (services: Services, loop: Loop, iteration: number): Promise<StopVerdict> => {
    const path = join(services.workspace.root, LOOP_DIR, loop.conversationId, `iteration-${iteration}.json`);
    let raw: unknown;
    try {
        raw = JSON.parse(await readFile(path, "utf8"));
    } catch {
        return { done: false, detail: `No verdict file — the iteration ended without writing iteration-${iteration}.json.` };
    }
    const parsed = LoopVerdictSchema.safeParse(raw);
    if (!parsed.success) {
        return { done: false, detail: `Verdict file did not match the required shape: ${parsed.error.issues[0]?.message ?? "invalid"}.` };
    }
    return { done: parsed.data.done, detail: parsed.data.reason.slice(0, DETAIL_TAIL) };
};

/* The judge: a second model, no tools, no transcript, ruling on the goal against the rubric.
 *
 * It is shown the goal, the rubric and the iteration's own closing report — and NOT the diff. That is a real
 * limitation and it is the honest one: the judge runs through the quick-model seam (one prompt, one string, no
 * filesystem), so what it can rule on is whether the work as DESCRIBED meets the bar. That still catches the
 * failure this exists for — an agent that stops while its own account of what it did plainly falls short of the
 * goal — and it does so for the price of one cheap call. A judge that must inspect the tree is a `command`.
 *
 * The reply is parsed by its first word, and the prompt demands that shape. Deliberately strict: a judge whose
 * "DONE" has to be found somewhere inside a paragraph is a judge whose verdict depends on how it phrased
 * itself, and anything unrecognized falls through to not-done, which is the safe direction.
 */
const askJudge = async (services: Services, loop: Loop, report: string, signal: AbortSignal): Promise<StopVerdict> => {
    if (loop.stop.kind !== "judge") {
        return { done: false };
    }
    const prompt = [
        `You are reviewing whether a coding agent has finished a job. You did none of this work and have no stake in it being done.`,
        ``,
        `THE GOAL:`,
        loop.goal,
        ``,
        `THE RUBRIC — the bar the goal has to clear:`,
        loop.stop.rubric,
        ``,
        `WHAT THE AGENT SAYS IT DID, in its own words:`,
        `---`,
        report.slice(-8_000),
        `---`,
        ``,
        `Answer with one word — DONE or CONTINUE — then one sentence of why.`,
        `Say DONE only if the report shows the rubric is met NOW. Partial work, work described as nearly finished, and work ` +
            `whose verification is not described are all CONTINUE. If the report is too vague to tell, that is CONTINUE.`,
    ].join(`\n`);
    try {
        const { text } = await askQuickModel(services, prompt, signal);
        const trimmed = text.trim();
        return { done: /^done\b/i.test(trimmed), detail: trimmed.slice(0, DETAIL_TAIL) };
    } catch (error) {
        // A judge that cannot run is not a verdict. Reported as the detail so the row says why the loop is
        // still going, rather than leaving a silent "not done" that looks like the judge ruled.
        return { done: false, detail: `Judge did not run: ${error instanceof Error ? error.message : "unknown error"}` };
    }
};

// The command check: exit 0 ⇒ the goal is met. Run in the conversation's OWN tree, not the workspace root —
// an isolated loop's work is in its worktree, and a check that ran against /work would be testing the code the
// loop has not landed yet. This is the automations guard's runner with the sign flipped, and the inversion is
// the point: there, non-zero means "skip"; here, zero means "stop".
const runCheck = async (command: string, cwd: string): Promise<StopVerdict> => {
    try {
        const { stdout, stderr } = await execFileAsync("sh", ["-c", command], { cwd, timeout: CHECK_TIMEOUT_MS });
        const detail = `${stderr}${stdout}`.trim().slice(-DETAIL_TAIL);
        return { done: true, ...(detail !== "" ? { detail } : {}) };
    } catch (error) {
        const { stdout, stderr } = error as { stdout?: string; stderr?: string };
        const detail = `${stderr ?? ""}${stdout ?? ""}`.trim().slice(-DETAIL_TAIL);
        return { done: false, ...(detail !== "" ? { detail } : {}) };
    }
};

// Evaluate this loop's stop condition against the iteration that just ended. `cwd` is the conversation's tree,
// `report` its closing assistant text (the judge's only evidence).
export const evaluateStop = async (
    services: Services,
    loop: Loop,
    params: { readonly iteration: number; readonly cwd: string; readonly report: string; readonly signal: AbortSignal },
): Promise<StopVerdict> => {
    if (loop.stop.kind === "command") {
        return runCheck(loop.stop.command, params.cwd);
    }
    if (loop.stop.kind === "claim") {
        return readClaim(services, loop, params.iteration);
    }
    return askJudge(services, loop, params.report, params.signal);
};
