import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { Logger } from "pino";
import type { ConversationActors } from "../../conversations/actor/conversation-actors.js";
import type { RoutedTurn } from "../../seams/turn-starter.js";
import { opt } from "../../opt.js";
import { lastLentToRunner } from "../ownership/account-holds.js";

/* WHO CARRIES A RUNNER'S FAILED TURN ON: this sandbox, never the runner. A failure frame says `autoResume: "scheduled"`
   when the daemon that classified it booked a re-run in its own resume pass. A runner's frame said so of the runner's own
   pass, and this sandbox relayed it as its own word: the card read "resuming", the chat promised the turn "continues
   automatically", and nothing here had booked anything (2026-11-11, guitar-fm9e). The card stayed "resuming" for good,
   which held every message behind a recovery that would never come and kept Archive off the card; and the runner's own
   pass, re-minting against an account list it does not have, gave up with "reconnect the account".

   Now a runner books nothing for a dispatched turn (stream-agent.ts, runner mode), and this sandbox decides here, where
   the frame arrives. A Claude token the runner was refused on is this sandbox's to renew: the turn is held for the same
   re-mint and re-run a local one gets (turn-resume.ts, the `auth` rung), and the re-run is dispatched to the runner again
   with a freshly resolved credential. Any other booking a runner claims (an older runner still books its own) is
   offered for a press instead, since nothing here holds it. */

type ErrorFrame = Extract<AgentEvent, { kind: "error" }>;

export interface RemoteFailureDeps {
    readonly conversations: Pick<ConversationActors, "send">;
    readonly logger: Pick<Logger, "info">;
}

// The frames that mean the provider answered, so a re-run knows its session holds the turn's own words.
const ANSWERS: ReadonlySet<AgentEvent["kind"]> = new Set(["delta", "thinking", "tool_call"]);

/** The frame with no re-run promised: one is available for a press, none is booked. */
export const unbooked = (frame: ErrorFrame): ErrorFrame => {
    if (frame.autoResume !== "scheduled") {
        return frame;
    }
    const { nextAt: _nextAt, ...rest } = frame;
    return { ...rest, autoResume: "available" };
};

// What one failure frame from the runner becomes here: held for a re-mint, or offered for a press.
const failureHere = (
    deps: RemoteFailureDeps,
    turn: RoutedTurn & { readonly conversationId: string },
    runnerId: string,
    frame: ErrorFrame,
    seen: { readonly sessionId: string | undefined; readonly answered: boolean },
): ErrorFrame => {
    const { conversationId } = turn;
    // A re-mint's own re-run refused again is dead: re-minting once more would only replay it.
    if (frame.code === "claude-token-refused" && frame.account !== undefined && turn.resume !== "auth") {
        const { account } = frame;
        // An unknown token never matches the stored one, so the re-mint adopts whatever this sandbox holds now.
        const refusedToken = lastLentToRunner(runnerId, account) ?? "";
        deps.conversations.send(conversationId, {
            kind: "turn-held",
            held: {
                input: turn,
                reason: "auth",
                ran: seen.answered,
                ...opt("sessionId", seen.sessionId),
                remint: { account, refusedToken },
            },
        });
        deps.logger.info({ conversationId, runner: runnerId, account }, "runner turn refused its borrowed Claude token: held here for a re-mint and a re-run on the runner");
        const { nextAt: _nextAt, ...rest } = frame;
        return { ...rest, autoResume: "scheduled" };
    }
    if (frame.autoResume === "scheduled") {
        deps.logger.info({ conversationId, runner: runnerId, code: frame.code }, "runner turn: the runner promised a re-run this sandbox does not hold, so it is offered for a press");
    }
    return unbooked(frame);
};

/** The runner's frames as this sandbox relays them, every failure decided here (see above). */
export async function* remoteFailuresHere(
    deps: RemoteFailureDeps,
    turn: RoutedTurn & { readonly conversationId: string },
    runnerId: string,
    frames: AsyncIterable<AgentEvent>,
): AsyncGenerator<AgentEvent> {
    let sessionId = turn.sessionId;
    let answered = false;
    for await (const frame of frames) {
        if (frame.kind === "session") {
            sessionId = frame.sessionId;
        }
        answered ||= ANSWERS.has(frame.kind);
        yield frame.kind === "error" ? failureHere(deps, turn, runnerId, frame, { sessionId, answered }) : frame;
    }
}
