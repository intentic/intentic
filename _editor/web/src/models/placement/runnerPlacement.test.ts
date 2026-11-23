// The conversation a runner view that is not any one conversation's (a desktop, a window nobody owns) is asked through.
import "@intentic/testing/dom";
import { conversationOnRunner } from "./runnerPlacement";

it("asks through a conversation placed on that runner, never an archived one", () => {
    const agents = [{ id: `here` }, { id: `old`, runner: `rog`, archivedAt: 1 }, { id: `live`, runner: `rog` }, { id: `other`, runner: `z440` }];
    expect([conversationOnRunner(`rog`, agents), conversationOnRunner(`z440`, agents), conversationOnRunner(`omen`, agents)]).toEqual([`live`, `other`, undefined]);
});
