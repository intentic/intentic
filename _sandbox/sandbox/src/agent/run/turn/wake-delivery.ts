import { sleep } from "@intentic/base/async";
import type { TurnProfile } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import type { SteerVoice, TurnStarter } from "../../../seams/turn-starter.js";

// The one door for words nobody at a conversation's composer typed: steered into its live turn, or opening one.

export interface Wake {
    readonly conversationId: string;
    readonly prompt: string;
    readonly voice: Exclude<SteerVoice, "person">;
    // The source of outside content in the prompt; whatever turn it reaches is tainted by it.
    readonly outside?: string;
    // The turn the wake continues, whole; conversation, prompt, session and taint are the wake's own.
    readonly profile: TurnProfile;
}

// The port's two doors a wake knocks on, and where it reads the session a fresh turn continues.
export interface WakeDoors {
    readonly turns: Pick<TurnStarter, "steer" | "start">;
    readonly sessionIdOf: (conversationId: string) => string | undefined;
}

export type WakeLanding = "steered" | "started" | "busy";

/** One attempt: the live turn if it takes words, else a fresh turn on the conversation's current session. */
export const wakeOnce = async (doors: WakeDoors, wake: Wake): Promise<WakeLanding> => {
    const steered = await doors.turns.steer(wake.conversationId, {
        text: wake.prompt,
        voice: wake.voice,
        ...(wake.outside === undefined ? {} : { outside: wake.outside }),
    });
    if (steered === true) {
        return "steered";
    }
    const sessionId = doors.sessionIdOf(wake.conversationId);
    const started = await doors.turns.start({
        ...wake.profile,
        conversationId: wake.conversationId,
        prompt: wake.prompt,
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(wake.outside === undefined ? {} : { outsideWake: wake.outside }),
    });
    return started === undefined ? "busy" : "started";
};

export interface WakePacing {
    readonly attempts: number;
    readonly retryMs: number;
    readonly logger: Logger;
    // Carried on every log line of this wake.
    readonly context: Readonly<Record<string, unknown>>;
}

/** Retries until the words land; "busy" means every attempt found the conversation occupied, for the caller to report. */
export const deliverWake = async (doors: WakeDoors, wake: Wake, pacing: WakePacing): Promise<WakeLanding> => {
    for (let attempt = 0; attempt < pacing.attempts; attempt += 1) {
        try {
            const landing = await wakeOnce(doors, wake);
            if (landing !== "busy") {
                pacing.logger.info({ ...pacing.context, conversationId: wake.conversationId, landing }, "wake: delivered");
                return landing;
            }
        } catch (error) {
            pacing.logger.warn({ ...pacing.context, err: error, conversationId: wake.conversationId }, "wake: turn failed to start, retrying");
        }
        if (attempt + 1 < pacing.attempts) {
            await sleep(pacing.retryMs, { unref: true });
        }
    }
    return "busy";
};
