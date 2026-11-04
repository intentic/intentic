import { insidePath, page } from "@intentic/sandbox-contract/app-routes";
import { activeSandboxId } from "../../app/storage/activeSandbox";
import { agentChangesPath, agentPagePath, mobileChatPath, ownsWayBack, PHONE_HOME } from "./phoneScreens";

// A phone's screens, inside the sandbox open while no route says another frame.
const BOX = `a1b2c3d4e5f6`;
beforeEach(() => {
    activeSandboxId.value = BOX;
});

describe(`ownsWayBack`, () => {
    it(`is the board and every conversation under it, in either form of address`, () => {
        expect(ownsWayBack(insidePath(BOX, page.agents()))).toBe(true);
        expect(ownsWayBack(insidePath(BOX, page.agent(`cnv_1`)))).toBe(true);
        expect(ownsWayBack(`/agents`)).toBe(true);
        expect(ownsWayBack(`/agents/cnv_1`)).toBe(true);
    });

    it(`leaves every screen the rail opens to draw the shell's back arrow`, () => {
        expect(ownsWayBack(insidePath(BOX, page.menu()))).toBe(false);
        expect(ownsWayBack(insidePath(BOX, page.workspace()))).toBe(false);
        expect(ownsWayBack(insidePath(BOX, page.sandboxSettings()))).toBe(false);
        expect(ownsWayBack(insidePath(BOX, page.extension(`approvals`)))).toBe(false);
    });

    it(`matches the page, not a prefix of a word`, () => {
        expect(ownsWayBack(`/agentsmith`)).toBe(false);
    });
});

describe(`mobileChatPath`, () => {
    it(`is the agent's page, with the id escaped`, () => {
        expect(mobileChatPath(`cnv_1`)).toBe(`/s/${BOX}/agents/cnv_1`);
        expect(mobileChatPath(`a/b`)).toBe(`/s/${BOX}/agents/a%2Fb`);
    });

    it(`stays in Home's frame for a route in it`, () => {
        expect(mobileChatPath(`cnv_1`, { meta: { frame: `home`, page: `chat` }, params: { sandbox: `other` } })).toBe(`/home/other/agents/cnv_1`);
    });

    it(`keeps the board's address from before frames for the Android app's bridge`, () => {
        expect(PHONE_HOME).toBe(`/agents`);
    });
});

// The two addresses under an agent the Android app opens in its WebView (router/nativeHandoff.ts keeps them there).
describe(`an agent's Changes and its pages`, () => {
    it(`is the agent's page asked for its review`, () => {
        expect(agentChangesPath(`cnv_1`)).toBe(`/s/${BOX}/agents/cnv_1?view=changes`);
    });

    it(`is one page under the agent's, by the page's id, both ids escaped`, () => {
        expect(agentPagePath(`cnv_1`, `a1b2c3d4e5`)).toBe(`/s/${BOX}/agents/cnv_1/pages/a1b2c3d4e5`);
        expect(agentPagePath(`a/b`, `c d`)).toBe(`/s/${BOX}/agents/a%2Fb/pages/c%20d`);
    });

    it(`draws its own way back, as the agent's screen does`, () => {
        expect(ownsWayBack(agentPagePath(`cnv_1`, `a1b2c3d4e5`))).toBe(true);
    });
});
