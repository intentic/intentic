import { KeyedProviderSchema } from "@intentic/sandbox-contract";
import type { Services } from "../../../composition.js";
import { limitReopensAt } from "../../models/limit-reset.js";
import { limitWayOf } from "../../models/limit-way.js";
import type { FailureQueries } from "./classify-failure.js";

// The questions a failure's classification asks of the daemon's own records rather than of a conversation: when a spent
// allowance reopens, the way on, and which routed sign-ins wait on their owner. Every request a runtime runs has these;
// a conversation's own two (its break policy and its stop ladder) are added where there is one (stream-agent.ts).
export type RecordQueries = Omit<FailureQueries, "breakPolicy" | "stopLadder">;

export const recordQueries = (services: Services): RecordQueries => ({
    reopensAt: (at) => limitReopensAt({ services, ...at }),
    limitWay: (params) => limitWayOf(services, params),
    awaitingVerification: async (provider) => {
        const keyed = KeyedProviderSchema.safeParse(provider);
        if (!keyed.success) {
            return [];
        }
        return (await services.cliProxy.accounts())[keyed.data].flatMap((account) => (account.cooling?.verify === undefined ? [] : [account.label]));
    },
});
