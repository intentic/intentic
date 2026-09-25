import type { AgentCapabilities, AgentEvent } from "@intentic/sandbox-contract";
import type { AgentRequest } from "../../agent/providers/agent-request.js";
import { withFileNote } from "../../agent/prompt/attachment-note.js";
import type { CommandGuard } from "../../guard/command-guard.js";
import { type AttachedImage, loadAttachments } from "./attachment-images.js";
import { EXECUTE_PROMPT, PLAN_PREAMBLE, type PlanPhaseResult, planMode } from "./plan-mode.js";
import { vendorTurnGate } from "./vendor-gate.js";

// A vendor loop that opens something to run its turn on, a connection or a process, and serves the turn there.
export interface VendorTurn<S> {
    // A throw ends the turn with its message, or `unopened` when it carries none.
    readonly open: () => Promise<S> | S;
    readonly unopened: string;
    // The turn itself, under the one rulebook gate minted for it.
    readonly serve: (handle: S, gate: CommandGuard) => AsyncGenerator<AgentEvent>;
    // A throw from `serve` as the sentence its error frame carries; a throwing turn surfaces, never swallows.
    readonly failure: (error: unknown, handle: S) => string;
    // Runs once the turn is over, before its gate is released.
    readonly close?: (handle: S) => void;
}

// Opens the turn's handle, then serves it under one gate; every way out, a failure to open included, ends in one `done`.
export async function* vendorTurn<S>(
    request: Pick<AgentRequest, "spec" | "policy" | "hooks" | "signal">,
    turn: VendorTurn<S>,
): AsyncGenerator<AgentEvent> {
    let handle: S;
    try {
        handle = await turn.open();
    } catch (error) {
        yield { kind: "error", message: error instanceof Error ? error.message : turn.unopened };
        yield { kind: "done" };
        return;
    }
    const { gate, release } = vendorTurnGate(request);
    try {
        yield* turn.serve(handle, gate);
    } catch (error) {
        yield { kind: "error", message: turn.failure(error, handle) };
    } finally {
        turn.close?.(handle);
        release();
    }
    yield { kind: "done" };
}

// One phase of a text-plan turn: `text` with `images` sent natively on `sessionId`, its text held back when planning.
export type TextPlanPhase = (
    text: string,
    images: readonly AttachedImage[],
    sessionId: string | undefined,
    planning: boolean,
) => AsyncGenerator<AgentEvent, PlanPhaseResult>;

// A text-only plan flow: planning names every attachment in the note, a direct run sends the pictures it read natively.
export async function* textPlanTurn(
    capabilities: Pick<AgentCapabilities, "permissions">,
    request: Pick<AgentRequest, "spec" | "policy" | "hooks" | "signal">,
    native: boolean,
    phase: TextPlanPhase,
): AsyncGenerator<AgentEvent> {
    const attached = await loadAttachments(request.spec, native);
    yield* planMode(
        capabilities,
        request,
        () => ({
            prompt: PLAN_PREAMBLE + withFileNote(request.spec.prompt, [...attached.files, ...attached.pictures]),
            plan: (prompt, sessionId) => phase(prompt, [], sessionId, true),
            execute: (sessionId) => phase(EXECUTE_PROMPT, [], sessionId, false),
        }),
        () => phase(withFileNote(request.spec.prompt, [...attached.files, ...attached.unread]), attached.images, request.spec.sessionId, false),
    );
}
