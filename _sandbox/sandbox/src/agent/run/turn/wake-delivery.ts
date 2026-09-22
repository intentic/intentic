import { sleep } from "@intentic/base/async";
import type { Logger } from "pino";
import type { Steer, SteerVoice } from "../../checkpoints/agent-steering.js";
import type { TurnInput } from "./turn-actor.js";

// The one door for words nobody at a conversation's composer typed: steered into its live turn, or opening one.

export interface Wake {
    readonly conversationId: string;
    readonly prompt: string;
    readonly voice: Exclude<SteerVoice, "person">;
    // The source of outside content in the prompt; whatever turn it reaches is tainted by it.
    readonly outside?: string;
    // The woken turn's routing and attribution; conversation, prompt, session and taint are the wake's own.
    readonly turn: Omit<TurnInput, "conversationId" | "prompt" | "sessionId" | "outsideWake">;
}

export interface WakeDoors {
    readonly steer: (conversationId: string, steer: Steer) => boolean;
    // False when a turn is already live on the conversation and took no steer.
    readonly start: (turn: TurnInput & { readonly conversationId: string }) => Promise<boolean>;
    readonly sessionIdOf: (conversationId: string) => string | undefined;
}

export type WakeLanding = "steered" | "started" | "busy";

/** One attempt: the live turn if it takes words, else a fresh turn on the conversation's current session. */
export const wakeOnce = async (doors: WakeDoors, wake: Wake): Promise<WakeLanding> => {
    if (
        doors.steer(wake.conversationId, { text: wake.prompt, voice: wake.voice, ...(wake.outside === undefined ? {} : { outside: wake.outside }) })
    ) {
        return "steered";
    }
    const sessionId = doors.sessionIdOf(wake.conversationId);
    const started = await doors.start({
        ...wake.turn,
        conversationId: wake.conversationId,
        prompt: wake.prompt,
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(wake.outside === undefined ? {} : { outsideWake: wake.outside }),
    });
    return started ? "started" : "busy";
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
