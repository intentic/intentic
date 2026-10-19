import { mobileChatPath, ownsWayBack } from "./phoneScreens";

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
