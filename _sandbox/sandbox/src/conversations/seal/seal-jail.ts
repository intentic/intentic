import type { Services } from "../../composition.js";
import { houseOf, jailWanted } from "../../auth/members/seal-house.js";

// How many conversations are private right now, live and archived: an archived one's transcript is still on the volume.
export const sealedCount = (agents: Pick<Services["agents"], "list" | "listArchived">): number =>
    agents.list().filter((agent) => agent.seal !== undefined).length + agents.listArchived().filter((agent) => agent.seal !== undefined).length;

/**
 * Whether every turn, and every shell a person opens, runs in the sandbox jail with the history volume out of its reach
 * (seal-house.ts jailWanted): while the house rule lets anything be private, and while anything still is. Read as each
 * turn is planned, so a change applies from the next turn of every conversation.
 */
export const sealJailWanted = async (services: Pick<Services, "sealHouse" | "orgPolicy" | "agents">): Promise<boolean> => {
    const house = houseOf(await services.sealHouse.read(), await services.orgPolicy.current());
    return jailWanted(house.mode, sealedCount(services.agents));
};
