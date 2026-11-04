import { sealContract } from "@intentic/sandbox-contract/contracts/seal.contract";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../../app-env.js";
import type { Services } from "../../composition.js";
import { approveOpen, openWithoutAsking, prepareOpen } from "./seal-openers.js";
import { createSealOpenings } from "./seal-open.js";
import { answerAsk, askToRead, setPrivate } from "./seal-readers.js";
import { sealKit, signedIn } from "./seal-kit.js";

/* PRIVATE CONVERSATIONS' ROUTES (contracts/seal.contract.ts). Only a person reaches them (no route here is open to an
 * agent, a panel or a control token), and each decides whose hands it may be in: the author changes the seal and answers
 * who asks (seal-readers.ts); anyone shown the card may ask; the sandbox owner alone opens one without asking, with their
 * passkey, and a second person with Full access agrees where an organisation asks for two (seal-openers.ts). Every route
 * aimed at a subagent, a review or a fork acts on the root its seal comes from (seal-family.ts). */

// `replaceShells`: people's shells follow a change at once rather than at the next terminal or turn (router.ts fills it).
export const createSealRoutes = (services: Services, replaceShells: () => void) => {
    const i = implement(sealContract).$context<OrpcContext>();
    const kit = sealKit(services, replaceShells);
    const openings = createSealOpenings(services);
    const origin = (context: OrpcContext): string | undefined => context.headers.get("origin") ?? undefined;
    return {
        house: i.house.handler(async ({ context }) => await kit.houseFor(context.identity)),
        setHouse: i.setHouse.handler(async ({ input, context }) => {
            const caller = signedIn(context);
            const house = await kit.bindingHouse();
            if (house.locked) {
                throw new ORPCError("FORBIDDEN", { message: "your organisation set who reads whose conversations here" });
            }
            await services.sealHouse.setMode(input.mode);
            // Never opens anything: a rule that lets conversations be private makes every home private to its person.
            if (input.mode !== "everyone") {
                await kit.sealHomes();
            }
            kit.record(caller, "seal.house.set", input.mode, { from: house.mode });
            kit.replaceShells();
            return await kit.houseFor(caller);
        }),
        setDefault: i.setDefault.handler(async ({ input, context }) => {
            const caller = signedIn(context);
            await services.sealHouse.setDefault(caller.email, input.private);
            return await kit.houseFor(caller);
        }),
        set: i.set.handler(async ({ input, context }) => await setPrivate(kit, signedIn(context), input)),
        ask: i.ask.handler(async ({ input, context }) => await askToRead(kit, signedIn(context), input.id)),
        answer: i.answer.handler(async ({ input, context }) => await answerAsk(kit, signedIn(context), input)),
        prepareOpen: i.prepareOpen.handler(async ({ input, context }) => await prepareOpen(kit, openings, signedIn(context), input, origin(context))),
        open: i.open.handler(async ({ input, context }) => await openWithoutAsking(kit, openings, signedIn(context), input, origin(context))),
        approveOpen: i.approveOpen.handler(async ({ input, context }) => await approveOpen(kit, signedIn(context), input)),
    };
};
