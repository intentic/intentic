import { waitingInChats } from "./useWaitingAgents";

// The page counts what waits in agents' own chats, so it can point there instead of reading "Nothing waiting".
const none = { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false };

describe("agents waiting in their chats", () => {
    test("counts every ask a chat answers, once per agent", () => {
        const agents = [
            { attention: { ...none, permission: true } },
            { attention: { ...none, question: true, permission: true } },
            { attention: { ...none, plan: true } },
            { attention: { ...none, capability: true } },
            { attention: { ...none, credential: true } },
        ];
        expect(waitingInChats(agents)).toBe(5);
    });

    // A refused land is the review page's, and an idle agent owes nothing.
    test("leaves out a land conflict and an agent asking nothing", () => {
        expect(waitingInChats([{ attention: { ...none, conflict: true } }, { attention: none }])).toBe(0);
    });
});
