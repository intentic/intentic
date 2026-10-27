// A home conversation's work arrives one fixed way, which its composer says rather than offers: landed and committed
// when a turn ends, or held for a maintainer where its person may not land. Every other chat has no such pill.
import { homeConversationId } from "@intentic/sandbox-contract/ids/conversation-ids";
import { homeLandingOf } from "./composerLanding";

const home = homeConversationId(`ada@example.com`);

it(`says a home lands and commits for a person who may land here, and asks a maintainer for one who may not`, () => {
    expect(homeLandingOf({ conversationId: home, box: undefined }, true)).toBe(`lands`);
    expect(homeLandingOf({ conversationId: home, box: undefined }, false)).toBe(`asks`);
});

it(`says nothing for an ordinary chat, or for a home drawn from another box`, () => {
    expect(homeLandingOf({ conversationId: `brisk-alder-x7k2`, box: undefined }, true)).toBeUndefined();
    expect(homeLandingOf({ conversationId: home, box: `box-2` }, true)).toBeUndefined();
});
