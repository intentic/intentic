// jsdom because the roster store's import chain reaches the app's environment read at module eval.
import "@intentic/testing/dom";
import type { AgentSummary } from "@intentic/sandbox-contract";
import { registry } from "../../agents/fleet/useAgents-registry";
import { landingLine, landingNow } from "./landing";

// The review's one signal that this tree is being written from outside it. It is the roster's own status, not a second
// wire field, so what the fleet board shows and what the Changes panel says can never disagree.

// Nothing here reads past `status` and `title`; the rest is what the wire shape requires.
const NOTHING_OWED: AgentSummary[`attention`] = {
    plan: false,
    question: false,
    permission: false,
    capability: false,
    credential: false,
    conflict: false,
};

const agent = (id: string, status: AgentSummary[`status`], title?: string): AgentSummary => ({
    id,
    status,
    provider: `claude`,
    harness: `native`,
    updatedAt: 0,
    attention: NOTHING_OWED,
    ...(title === undefined ? {} : { title }),
});

afterEach(() => {
    registry.value = [];
});

it(`names what is landing, and says nothing when nothing is`, () => {
    registry.value = [agent(`a1`, `running`, `Rewrite the parser`), agent(`a2`, `landed`, `Fix the badge`)];
    expect(landingNow.value).toBe(false);
    expect(landingLine.value).toBeUndefined();

    // A turn's own end-of-turn land keeps the card `running` (agents-registry statusOf), so only a land between turns
    // reaches this — which is exactly the one the user pressed a button for and is now waiting on.
    registry.value = [agent(`a1`, `landing`, `Rewrite the parser`), agent(`a2`, `landed`, `Fix the badge`)];
    expect(landingNow.value).toBe(true);
    expect(landingLine.value).toBe(`Landing Rewrite the parser`);
});

it(`counts the rest rather than listing them, and still names an untitled one`, () => {
    registry.value = [agent(`a1`, `landing`, `Rewrite the parser`), agent(`a2`, `landing`, `Fix the badge`), agent(`a3`, `landing`)];
    expect(landingLine.value).toBe(`Landing Rewrite the parser and 2 more`);

    registry.value = [agent(`a3`, `landing`)];
    expect(landingLine.value).toBe(`Landing a conversation`);
});
