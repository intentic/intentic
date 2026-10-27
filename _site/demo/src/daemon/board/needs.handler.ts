import { answerDemoNeed, demoGrants, demoNeeds, provideDemoSecret, revokeDemoGrant } from "../../fixture/needs";
import { broadcastRoster } from "./roster";
import type { Doors } from "../doors";

// What the agents wait on people for, answered for real against the fixture store (docs/architecture/needs.md).
export const needsDoors = {
    list: ({ conversationId, open }) => ({
        needs: demoNeeds().filter(
            (need) =>
                (conversationId === undefined || need.conversationId === conversationId) &&
                (open !== true || need.status === `open` || need.status === `working`),
        ),
    }),
    answer: ({ id, answer }) => {
        const need = answerDemoNeed(id, answer);
        broadcastRoster();
        return need;
    },
    release: ({ id, answer }) => {
        const need = answerDemoNeed(id, { kind: answer });
        broadcastRoster();
        return need;
    },
    provideSecret: ({ id }) => {
        const need = provideDemoSecret(id);
        broadcastRoster();
        return need;
    },
    grants: () => demoGrants(),
    revokeGrant: (grant) => {
        revokeDemoGrant(grant);
        return { ok: true };
    },
} satisfies Doors<`needs`>;
