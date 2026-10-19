import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { Logger } from "pino";
import type { Config } from "../env.config.js";
import { callIngress } from "../system/platform-client.js";

/* THE FINISH-THE-TURN GRACE, the daemon's half. The platform meters the trial per model call, and twelve calls is less
 * than one small task: the first one stopped mid-edit (onboarding review 2026-10-18, F01). A turn that opens while a step
 * of today's allowance is left may now run past it to finish, within a daily cap the platform keeps (its trial-usage.ts).
 * The calls reach the platform through the translator, which carries no turn, so this says when a trial turn opens and
 * closes. */

export type TrialTurnState = "open" | "close";
// Tells the platform a trial turn opened or closed; answers whether it earned the grace. Never rejects.
export type TellTrialTurn = (state: TrialTurnState) => Promise<boolean>;

// The turn waits this long for the platform, then runs without the grace: the answer decides whether the turn may
// finish past the allowance, never whether it starts.
const TELL_WAIT_MS = 3_000;

const UNHEARD = {
    open: "trial: the platform did not hear the turn open; it runs without the finish-the-turn grace",
    close: "trial: the platform did not hear the turn close; its grace lapses on its own",
} satisfies Record<TrialTurnState, string>;

export const tellPlatform =
    (deps: { readonly config: Config; readonly logger: Pick<Logger, "warn"> }): TellTrialTurn =>
    async (state) => {
        // No platform to tell (a runner on its parent's translator): the turn runs as it always did.
        if (deps.config.platform.url === "" || deps.config.connectToken === "") {
            return false;
        }
        try {
            const answer = await callIngress(deps.config, { route: "trialTurn", input: { state }, signal: AbortSignal.timeout(TELL_WAIT_MS) });
            return answer.data?.grace === true;
        } catch (error) {
            deps.logger.warn({ err: error, state }, UNHEARD[state]);
            return false;
        }
    };

// Runs a trial turn between its opening and its closing, however it ends. Only a turn that earned the grace closes:
// the platform counts the open ones, and a close for a turn it never counted would end another turn's grace.
export async function* withTrialTurn(tell: TellTrialTurn, run: () => AsyncGenerator<AgentEvent>): AsyncGenerator<AgentEvent> {
    const graced = await tell("open");
    try {
        yield* run();
    } finally {
        if (graced) {
            void tell("close");
        }
    }
}
