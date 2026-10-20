import type { Services } from "../../../composition.js";
import { FAN_OUT } from "../../subagents/fan-out-governor.js";
import { isSpawnedChild } from "../../subagents/children.js";
import { turnPulseOf } from "../turn/turn-pulse.js";
import { turnSpend } from "./token-meter.js";

/* WHERE THE BURN RATES HEAR WHAT THEY LEARN FROM, wired once at boot (bootstrap/boot-schedulers.ts). Each answers its
   unsubscribe, and neither throws: a reading or a turn that cannot be learned from costs the rates one sample. Both may
   also free the room a child the fan-out budget holds is waiting for, so the governor asks its held starts again. */

/** Every reading is kept and learned from (burn-rates.ts): what one point of the account's window cost. */
const learnFromReadings = (services: Pick<Services, "headroom" | "burnRates">): (() => void) =>
    services.headroom.onChange((provider, account, usage) => {
        if (usage !== undefined) {
            void services.burnRates.reading(provider, account, usage).then(() => FAN_OUT.reconsider(provider));
        }
    });

/** Every settled turn's model pace is learned from what the meter saw of it (token-meter.ts), once per turn. */
const learnFromTurns = (services: Pick<Services, "events" | "burnRates" | "conversations">): (() => void) => {
    // The turn each conversation last taught, since a run that settles before its runtime starts finds the last one's pulse.
    const taught = new Map<string, string>();
    return services.events.subscribe("run.settled", ({ conversationId }) => {
        const pulse = turnPulseOf(conversationId);
        if (pulse?.endedAt === undefined || taught.get(conversationId) === pulse.turnId) {
            return;
        }
        taught.set(conversationId, pulse.turnId);
        const spend = turnSpend(conversationId, pulse.turnId);
        const learned = spend === undefined ? Promise.resolve() : services.burnRates.turnEnded({ ...spend, endedAt: pulse.endedAt, child: isSpawnedChild(services.conversations, conversationId) });
        // Whatever it was, what it spent no longer runs: a child the budget held on its provider may fit now.
        void learned.then(() => FAN_OUT.reconsider(pulse.provider));
    });
};

/** Both of the above, as one unsubscribe. */
export const learnBurnRates = (services: Pick<Services, "headroom" | "events" | "burnRates" | "conversations">): (() => void) => {
    const stops = [learnFromReadings(services), learnFromTurns(services)];
    return () => {
        for (const stop of stops) {
            stop();
        }
    };
};
