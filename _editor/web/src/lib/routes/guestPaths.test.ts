import { floatingPath, homePath, insidePath, page } from "@intentic/sandbox-contract/app-routes";
import { guestAllowedPath, guestFenceOf, homeOnlyAllowedPath } from "./guestPaths";

// The pages a guest may stand on, and the ones the shell sends it home from: pinned so a new page lands on the refused
// side by default. Judged by the page an address names and its frame, in either form an address comes in.
const BOX = `a1b2c3d4e5f6`;
const inside = (link: Parameters<typeof insidePath>[1]) => insidePath(BOX, link);

describe(`guestAllowedPath`, () => {
    it(`admits the chat, the board of its own conversations, its settings, and the access section`, () => {
        for (const path of [
            inside(page.chat()),
            inside(page.agents()),
            inside(page.agent(`abc`)),
            inside(page.agentPage(`abc`, `p1`)),
            inside(page.account()),
            inside(page.account(`appearance`)),
            homePath(undefined, page.account(`appearance`)),
            inside(page.sandboxSettings(`access`, { query: { section: `people` } })),
            floatingPath(BOX, `chat`),
            `/login`,
            `/invite/tok_1`,
            // The same pages at their addresses from before frames.
            `/chat`,
            `/agents`,
            `/agents/abc`,
            `/settings`,
            `/settings/appearance`,
            `/sandbox/access`,
            `/floating/chat`,
        ]) {
            expect(guestAllowedPath(path), path).toBe(true);
        }
    });

    it(`refuses the tree, the box, the capabilities, the live surfaces, Home, and anything unnamed`, () => {
        for (const path of [
            `/`,
            inside(page.workspace()),
            inside(page.workspace(`src/app.ts`)),
            inside(page.capabilities()),
            inside(page.browsers()),
            inside(page.terminal()),
            inside(page.sandboxSettings()),
            inside(page.sandboxSettings(`secrets`)),
            inside(page.extension(`pipelines`)),
            floatingPath(BOX, `terminal`),
            homePath(BOX, page.chat()),
            homePath(BOX),
            homePath(),
            `/workspace`,
            `/preview`,
            `/desktop`,
            `/sandbox/accessories`,
            `/ext/pipelines`,
        ]) {
            expect(guestAllowedPath(path), path).toBe(false);
        }
    });
});

// A home-only guest stands in the master view and on the sessions its home started, never on a chat of its own or a
// board, so the shell sends it to Home from anywhere else.
describe(`homeOnlyAllowedPath`, () => {
    it(`admits the master view, a session page, its settings and the access section`, () => {
        for (const path of [
            homePath(),
            homePath(BOX),
            inside(page.agent(`abc`)),
            homePath(BOX, page.agent(`abc`)),
            homePath(undefined, page.account()),
            inside(page.account(`appearance`)),
            inside(page.sandboxSettings(`access`)),
            `/agents/abc`,
            `/settings/appearance`,
            `/sandbox/access`,
            `/invite/tok_1`,
            `/login`,
        ]) {
            expect(homeOnlyAllowedPath(path), path).toBe(true);
        }
    });

    it(`refuses the chat, the board, the tree and anything unnamed`, () => {
        for (const path of [
            `/`,
            inside(page.chat()),
            inside(page.agents()),
            homePath(BOX, page.agents()),
            floatingPath(BOX, `chat`),
            inside(page.workspace()),
            inside(page.sandboxSettings()),
            `/chat`,
            `/agents`,
            `/floating/chat`,
            `/sandbox`,
            `/homework`,
        ]) {
            expect(homeOnlyAllowedPath(path), path).toBe(false);
        }
    });

    it(`is the fence a home-only guest gets, with Home as where it is sent, and the chat of its sandbox for any other`, () => {
        expect(guestFenceOf(true, BOX).home).toBe(homePath());
        expect(guestFenceOf(false, BOX).home).toBe(inside(page.chat()));
        expect(guestFenceOf(false).home).toBe(homePath());
        expect(guestFenceOf(false, BOX).allowed(homePath())).toBe(false);
    });
});
