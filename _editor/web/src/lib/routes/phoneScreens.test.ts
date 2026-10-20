import { agentChangesPath, agentPagePath, mobileChatPath, ownsWayBack } from "./phoneScreens";

describe(`ownsWayBack`, () => {
    it(`is the board and every conversation under it`, () => {
        expect(ownsWayBack(`/agents`)).toBe(true);
        expect(ownsWayBack(`/agents/cnv_1`)).toBe(true);
    });

    it(`leaves every screen the rail opens to draw the shell's back arrow`, () => {
        expect(ownsWayBack(`/menu`)).toBe(false);
        expect(ownsWayBack(`/workspace`)).toBe(false);
        expect(ownsWayBack(`/sandbox`)).toBe(false);
        expect(ownsWayBack(`/ext/approvals`)).toBe(false);
    });

    it(`matches the path, not a prefix of a word`, () => {
        expect(ownsWayBack(`/agentsmith`)).toBe(false);
    });
});

describe(`mobileChatPath`, () => {
    it(`is the agent route, with the id escaped`, () => {
        expect(mobileChatPath(`cnv_1`)).toBe(`/agents/cnv_1`);
        expect(mobileChatPath(`a/b`)).toBe(`/agents/a%2Fb`);
    });
});

// The two addresses under an agent the Android app opens in its WebView (router/nativeHandoff.ts keeps them there).
describe(`an agent's Changes and its pages`, () => {
    it(`is the agent route asked for its review`, () => {
        expect(agentChangesPath(`cnv_1`)).toBe(`/agents/cnv_1?view=changes`);
    });

    it(`is one page under the agent route, by the page's id, both ids escaped`, () => {
        expect(agentPagePath(`cnv_1`, `a1b2c3d4e5`)).toBe(`/agents/cnv_1/pages/a1b2c3d4e5`);
        expect(agentPagePath(`a/b`, `c d`)).toBe(`/agents/a%2Fb/pages/c%20d`);
    });

    it(`draws its own way back, as the agent's screen does`, () => {
        expect(ownsWayBack(agentPagePath(`cnv_1`, `a1b2c3d4e5`))).toBe(true);
    });
});
