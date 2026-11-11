import { type RunnerWakeAnswer, RunnerWakeAnswerSchema, type RunnerWakeRequest, runnerWakeUrl } from "@intentic/sandbox-contract/protocol/doors/runner-wake";
import type { MessageReceipt } from "@intentic/sandbox-contract/schemas/agent";
import type { Logger } from "pino";
import { opt } from "../../opt.js";
import type { Said, Unsaid } from "../../seams/turn-starter.js";
import type { RunnerIdentity } from "../runner-identity.js";

/* A RUNNER STARTS NO TURN OF ITS OWN. Its sandbox arms watches and runs background jobs for the turns its parent
   dispatched, and when one of those fired it woke the conversation on the runner: a turn the parent never heard of
   (2026-11-11, guitar-fm9e). The parent's card kept reading "resuming", messages for the conversation were held there
   instead of reaching the turn running on the runner, and when that turn finished nothing synced its work back, so it
   could never land. Now every word the runner's sandbox has for such a conversation goes to the parent, which says it as
   its own wake: the turn it starts is dispatched to the runner from the parent like any other, followed, synced back and
   landed there (the parent's door is wake.routes.ts). A conversation the parent did not dispatch to this runner (none, today) stays the runner's own. */

// Long enough for the parent to admit the words (a start, a steer or a queue); a wake that never answers is kept here.
const WAKE_TIMEOUT_MS = 30_000;

/** The runner's side: hands `said` to the parent, answered with what it did, or undefined to keep it here. */
export const parentWake =
    (identity: RunnerIdentity, logger: Pick<Logger, "info" | "warn">) =>
    async (said: Said): Promise<MessageReceipt | Unsaid | undefined> => {
        // A person's words reach a runner only through its parent, which already said them.
        if (said.voice !== "sandbox" && said.voice !== "agent") {
            return undefined;
        }
        const { turn } = said;
        const body: RunnerWakeRequest = {
            conversationId: turn.conversationId,
            prompt: turn.prompt,
            voice: said.voice,
            ...opt("outside", said.outside),
            ...opt("errand", turn.errand),
            ...opt("source", turn.speaker?.kind === "sandbox" ? turn.speaker.source : undefined),
            ...opt("messageId", turn.messageId),
        };
        let answer: RunnerWakeAnswer;
        try {
            const response = await fetch(runnerWakeUrl(identity.parentUrl), {
                method: "POST",
                headers: { authorization: `Bearer ${identity.token}`, "content-type": "application/json" },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(WAKE_TIMEOUT_MS),
            });
            if (!response.ok) {
                throw new Error(`the parent answered ${response.status}`);
            }
            answer = RunnerWakeAnswerSchema.parse(await response.json());
        } catch (error) {
            // An older parent (404) or one out of reach: the wake goes on here, as it did before the door existed.
            logger.warn({ err: error, conversationId: turn.conversationId }, "runner: the parent did not take a wake, so it is delivered here");
            return undefined;
        }
        if (!answer.forwarded) {
            return undefined;
        }
        logger.info({ conversationId: turn.conversationId, said: "delivered" in answer.said ? answer.said.delivered : "refused" }, "runner: wake handed to the parent");
        return answer.said;
    };
