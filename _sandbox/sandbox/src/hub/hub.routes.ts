import { hubContract } from "@intentic/sandbox-contract/contracts/hub.contract";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../app-env.js";
import type { Services } from "../composition.js";
import { HubRefusal } from "./hub-items.js";

// The connections hub's routes (contracts/hub.contract.ts), the owner's editor's way in. A refusal the hub can word
// (a computer not connected, a sign-in that cannot travel) answers 409 in those words.
const refusalAware = async <T>(act: () => Promise<T>): Promise<T> => {
    try {
        return await act();
    } catch (error) {
        if (error instanceof HubRefusal) {
            throw new ORPCError("CONFLICT", { message: error.message });
        }
        throw error;
    }
};

export const createHubRoutes = (services: Pick<Services, "connectionHub">) => {
    const i = implement(hubContract).$context<OrpcContext>();
    return {
        state: i.state.handler(() => services.connectionHub.state()),
        save: i.save.handler(({ input }) => refusalAware(() => services.connectionHub.save(input.target, input.machine))),
        take: i.take.handler(({ input }) => refusalAware(() => services.connectionHub.take(input.want, input.why))),
    };
};
