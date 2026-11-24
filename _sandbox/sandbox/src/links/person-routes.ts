import type { Services } from "../composition.js";
import { routeClientOf } from "../account-routing/route-client.js";
import { forgetPairing, requirePairing } from "../account-routing/require-pairing.js";
import { routeSecretsOf } from "../account-routing/route-secrets.js";
import { peopleFor } from "../account-routing/who-asks.js";
import type { PersonRoutes } from "./linked-destinations.js";

// HANDING WORK ON AS A PERSON, the asking side's seams off the daemon's services (2026-11-24, account-routing.md). Only a
// conversation that may hand work on gets here (its supervisor, the links gate), and the conversation is the one its
// turn stamp proved. It routes as the one person it acts for (who-asks.ts peopleFor, the owner when its chain names
// nobody); a conversation several people share hands nothing on as any of them, since none of them alone asked.

const SEVERAL =
    "This conversation acts for several people, so it cannot hand work on as any one of them. Hand it over a link, or ask the person who wants it to delegate from a conversation of their own.";

export const personRoutesOf = (services: () => Services): PersonRoutes => ({
    personOf: async (conversationId) => {
        const chain = peopleFor(services(), conversationId);
        const people = chain.length > 0 ? chain : [(await services().ownerEmail())?.toLowerCase()].filter((email) => email !== undefined);
        const [person, ...rest] = people;
        if (person === undefined) {
            return { refused: "Nobody signs in to this sandbox, so there is no person to hand work on as." };
        }
        return rest.length > 0 ? { refused: SEVERAL } : { person };
    },
    routeTo: (person, sandbox, fresh) => routeClientOf(services()).routeTo({ scope: "task", person, sandbox }, { fresh: fresh === true }),
    pairing: (conversationId, target, person) => requirePairing(services(), { conversationId, target, person, scopes: ["task"] }),
    secretFor: (sandboxId, person) => routeSecretsOf(services()).secretFor(sandboxId, person),
    forget: (sandboxId, person) => forgetPairing(services(), sandboxId, person),
});
