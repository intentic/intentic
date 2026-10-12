import { isAbsolute, resolve } from "node:path";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { z } from "zod";
import { type CommandGuard, consultWith, type GuardOutcome, vendorSubject } from "../../guard/command-guard.js";

// The one answer to a vendor CLI's own permission ask (ACP's session/request_permission, OpenCode's permission.asked),
// whatever the wire it came over. Each runtime reads its ask into a VendorAsk and maps the answer back onto its wire.

// A field the vendor may or may not fill: blank or another type reads as absent rather than failing the ask.
const field = z
    .string()
    .refine((value) => value.trim() !== "")
    .optional()
    .catch(undefined);

/**
 * The parts of a vendor's tool input an ask is judged by, read tolerantly at the wire: the input's shape is the
 * vendor's, so any other shape (null, a number, an array) reads as naming nothing, never as a failure.
 */
export const VendorToolInputSchema = z
    .object({
        // The command, under whichever of these names the vendor's tool uses; the first present wins.
        command: field,
        cmd: field,
        script: field,
        code: field,
        input: field,
        // The directory it runs in, likewise.
        cwd: field,
        workdir: field,
        dir_path: field,
        directory: field,
    })
    .catch({});
type VendorToolInput = z.infer<typeof VendorToolInputSchema>;

/**
 * The text the classifier reads from an ask: the first command field of the vendor's tool input, else the fallback the
 * ask carries (a title, a resource list) when it is not blank, else undefined.
 */
export const askProgramOf = (input: VendorToolInput, fallback?: string | null): string | undefined =>
    input.command ?? input.cmd ?? input.script ?? input.code ?? input.input ?? (fallback != null && fallback.trim() !== "" ? fallback : undefined);

/**
 * Where the asked command runs: the directory the vendor's tool input names, read against `base` when relative, else
 * `base`. Undefined leaves the gate on the turn's own cwd, which it already carries.
 */
export const askCwdOf = (input: VendorToolInput, base?: string): string | undefined => {
    const named = input.cwd ?? input.workdir ?? input.dir_path ?? input.directory;
    if (named === undefined) {
        return base;
    }
    if (isAbsolute(named)) {
        return named;
    }
    // A relative directory means something only against the one the vendor runs in; without it, the turn's own is safer.
    return base === undefined ? undefined : resolve(base, named);
};

export interface VendorAsk {
    // The tool the card names: the vendor's own name for it.
    readonly tool: string;
    // What the classifier reads; an ask with none is never consulted.
    readonly program: string | undefined;
    // Where the command runs, when the ask says; the gate falls back to the turn's cwd.
    readonly cwd?: string | undefined;
    // Whether the vendor offered a way to say no. Without one a consult could raise a card whose no nobody can enforce.
    readonly canRefuse: boolean;
}

// What answers asks for one turn: its rulebook gate, where the cards it raises go, and an optional hold on the turn's
// watchdog, taken for the consult so a card open on a person is not read as a stalled turn.
export interface AskJudge {
    readonly gate: CommandGuard;
    readonly push: (event: AgentEvent) => void;
    readonly hold?: () => () => void;
}

// `lasting` is whether a standing yes may be given ("always"): only when no rule is watching. Once the rulebook
// enforces, an "always" would let the vendor skip asking about later commands, so they would never reach it.
export type VendorAnswer = { readonly allow: true; readonly lasting: boolean } | { readonly allow: false; readonly reason: string };

// Fail closed: a consult that threw has no verdict to stand on, and an unanswered ask would stall the turn instead.
export const CONSULT_FAILED =
    "This could not be checked against your owner's safety policy, so it was refused. " +
    "Do not retry: carry on with what you can do without it, and say plainly what you left undone.";

/**
 * Answers one vendor ask: the owner's rulebook when it enforces, the ask carries a program and the vendor can take a
 * no; the standing yes otherwise. A consult that throws is a refusal, never an allow.
 */
export const answerVendorAsk = async (judge: AskJudge | undefined, ask: VendorAsk): Promise<VendorAnswer> => {
    if (judge === undefined || !judge.gate.enforcing) {
        return { allow: true, lasting: true };
    }
    if (ask.program === undefined || !ask.canRefuse) {
        return { allow: true, lasting: false };
    }
    const release = judge.hold?.();
    let outcome: GuardOutcome;
    try {
        outcome = await consultWith(judge.gate, ask.program, vendorSubject(ask.tool), judge.push, { cwd: ask.cwd });
    } catch {
        // allow(silent-catch): answered as a refusal naming the failure, the only verdict left to give
        outcome = { allow: false, reason: CONSULT_FAILED };
    } finally {
        release?.();
    }
    return outcome.allow ? { allow: true, lasting: false } : { allow: false, reason: outcome.reason };
};
