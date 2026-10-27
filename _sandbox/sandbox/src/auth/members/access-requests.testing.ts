import type { AccessRequest } from "@intentic/sandbox-contract/schemas/members";
import type { AccessRequestsStore } from "./access-requests.js";

// The request store in memory, for suites that drive the roster without a temp tree: nobody has asked for anything until
// a suite asks, and a grant or a dismissal answers it as the file store's does.
export const memoryAccessRequests = (): AccessRequestsStore => {
    const held = new Map<string, AccessRequest>();
    return {
        list: async () => [...held.values()].sort((left, right) => right.at - left.at),
        of: async (email) => held.get(email.toLowerCase()),
        ask: async (email, { want, place }, at) => {
            held.set(email.toLowerCase(), { email: email.toLowerCase(), want, place, at });
        },
        settle: async (email) => {
            held.delete(email.toLowerCase());
        },
    };
};
