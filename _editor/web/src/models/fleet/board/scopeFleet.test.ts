import type { AutomationApproval } from "@intentic/sandbox-contract/schemas/automations";
import { NO_ATTENTION } from "../../agent-status/agentStatus-lanes";
import type { FleetAgent } from "../useAgents-fleet";
import { attentionHidden } from "./scopeFleet";

// What the project and owner choices keep off the board, in the badge's own unit: the Attention lane's cards and the
// wakes held for the reader.

const card = (id: string, over: Partial<FleetAgent> = {}): FleetAgent => ({
    id,
    title: `agent ${id}`,
    status: `awaiting`,
    provider: `claude`,
    harness: `native`,
    updatedAt: 1_000,
    attention: NO_ATTENTION,
    open: false,
    unread: false,
    unsent: false,
    ...over,
});
const wake = (id: string, conversationId?: string): AutomationApproval => ({ id, automationId: `nightly`, createdAt: 1_000, conversationId });

const ME = `me@example.com`;
const ADA = `ada@example.com`;
const none = { held: [], personas: [], project: undefined, owner: undefined, me: ME };

describe(`attentionHidden`, () => {
    const fleet = [card(`shop`, { startIn: `shop` }), card(`api`, { startIn: `api` }), card(`web`, { startIn: `web` })];

    it(`is zero while nothing narrows the board`, () => {
        expect(attentionHidden({ ...none, fleet })).toBe(0);
    });

    it(`counts the cards that need the reader in the projects that are not open`, () => {
        expect(attentionHidden({ ...none, fleet, project: `shop` })).toBe(2);
    });

    it(`does not count what is not asking for the reader`, () => {
        const quiet = [card(`shop`, { startIn: `shop` }), card(`api`, { startIn: `api`, status: `landed` })];
        expect(attentionHidden({ ...none, fleet: quiet, project: `shop` })).toBe(0);
    });

    it(`counts a held wake that belongs to another project, and not one that belongs to the open one`, () => {
        const held = [wake(`one`, `api`), wake(`two`, `shop`)];
        expect(attentionHidden({ ...none, fleet, held, project: `shop` })).toBe(3);
    });

    it(`counts what another person's chip keeps off the board`, () => {
        const owned = [card(`mine`, { owner: { email: ME, since: 1 } }), card(`hers`, { owner: { email: ADA, since: 1 } })];
        expect(attentionHidden({ ...none, fleet: owned, owner: ME })).toBe(1);
    });
});
