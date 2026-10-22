import { guestAllowedPath, guestFenceOf, homeOnlyAllowedPath } from "./guestPaths";

// The prefixes a guest may stand on, and the ones the shell sends it home from: pinned so a new route lands on the
// refused side by default.
describe(`guestAllowedPath`, () => {
    it(`admits the chat, the board of its own conversations, its settings, and the access section`, () => {
        for (const path of [
            `/chat`,
            `/chat/abc`,
            `/agents`,
            `/agents/abc`,
            `/agent/abc`,
            `/settings`,
            `/settings/appearance`,
            `/sandbox/access`,
            `/floating/chat`,
        ]) {
            expect(guestAllowedPath(path), path).toBe(true);
        }
    });

    it(`refuses the tree, the box, the capabilities, the live surfaces, and anything unnamed`, () => {
        for (const path of [
            `/`,
            `/workspace`,
            `/workspace/src/app.ts`,
            `/preview`,
            `/capabilities`,
            `/browsers`,
            `/desktop`,
            `/terminal`,
            `/sandbox`,
            `/sandbox/secrets`,
            `/sandbox/accessories`,
            `/ext/pipelines`,
        ]) {
            expect(guestAllowedPath(path), path).toBe(false);
        }
    });
});

// A home-only guest stands in the master view and on the sessions its home started, never on a chat of its own or a
// board, so the shell sends it to /home from anywhere else.
describe(`homeOnlyAllowedPath`, () => {
    it(`admits the master view, a session page, its settings and the access section`, () => {
        for (const path of [
            `/home`,
            `/home/sbx-1`,
            `/agents/abc`,
            `/settings`,
            `/settings/appearance`,
            `/sandbox/access`,
            `/accept-invite`,
            `/login`,
        ]) {
            expect(homeOnlyAllowedPath(path), path).toBe(true);
        }
    });

    it(`refuses the chat, the board, the tree and anything unnamed`, () => {
        for (const path of [
            `/`,
            `/chat`,
            `/chat/abc`,
            `/agents`,
            `/agents/`,
            `/agent/abc`,
            `/floating/chat`,
            `/workspace`,
            `/sandbox`,
            `/homework`,
        ]) {
            expect(homeOnlyAllowedPath(path), path).toBe(false);
        }
    });

    it(`is the fence a home-only guest gets, with /home as where it is sent`, () => {
        expect(guestFenceOf(true).home).toBe(`/home`);
        expect(guestFenceOf(false).home).toBe(`/chat`);
        expect(guestFenceOf(false).allowed(`/home`)).toBe(false);
    });
});
