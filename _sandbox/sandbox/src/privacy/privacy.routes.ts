import { errorMessage } from "@intentic/base/errors";
import { privacyContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../app-env.js";
import type { Services } from "../composition.js";
import { nameDictionary } from "./name-dictionary.js";

// The privacy shield's page and the agent CLI's door: the status everybody may read, the policy only the owner may
// change (the route's floor says so, and the agent's token never reaches it), the log and the values behind its tokens
// (those the owner's alone too), and the taught datasets.
// Teaching masks more, so the agent may; forgetting masks less, so only the owner may.

// Unreadable stores are an error here, not an empty answer: an empty policy would read as the shield being off.
const failing = (error: unknown): ORPCError<"INTERNAL_SERVER_ERROR", unknown> =>
    new ORPCError("INTERNAL_SERVER_ERROR", { message: errorMessage(error), cause: error });

export const createPrivacyRoutes = (services: Pick<Services, "privacyShield" | "composeEnvironment" | "logger">) => {
    const i = implement(privacyContract).$context<OrpcContext>();
    const shield = services.privacyShield;
    return {
        status: i.status.handler(async () =>
            shield.status().catch((error: unknown) => {
                throw failing(error);
            }),
        ),
        setPolicy: i.setPolicy.handler(async ({ input }) => {
            await shield.setPolicy(input);
            // The policy decides whether the privacy pack rides the overlay (environment/privacy-pack.ts), so the
            // Environment card offers the rebuild that installs its readers, or drops them, the moment it changes. Saved
            // either way: a compose that failed is the overlay's problem, not a reason to refuse the owner's policy.
            await services.composeEnvironment().catch((error: unknown) => {
                services.logger.warn({ err: error }, "privacy policy saved, but recomposing the environment failed");
            });
            return { ok: true } as const;
        }),
        log: i.log.handler(() => shield.ledger.recent()),
        reveal: i.reveal.handler(async ({ input }) =>
            shield.reveal(input.tokens).catch((error: unknown) => {
                throw failing(error);
            }),
        ),
        dictionary: i.dictionary.handler(({ input }) => nameDictionary(input.query)),
        sources: i.sources.handler(async () =>
            shield.sources().catch((error: unknown) => {
                throw failing(error);
            }),
        ),
        learn: i.learn.handler(async ({ input }) => shield.learn(input.source, input.values)),
        forget: i.forget.handler(async ({ input }) => ({ forgotten: await shield.forget(input.source) })),
    };
};
