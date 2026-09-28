import { controlLine, parseControlLine } from "./control.js";

const TOKEN = `a`.repeat(64);

describe(`parseControlLine`, () => {
    it(`reads a grant and a revoke`, () => {
        expect(parseControlLine(JSON.stringify({ op: `grant`, token: TOKEN, id: `w1`, path: `/home/me/project`, kind: `folder` }))).toEqual({
            op: `grant`,
            token: TOKEN,
            id: `w1`,
            path: `/home/me/project`,
            kind: `folder`,
        });
        expect(parseControlLine(JSON.stringify({ op: `revoke`, token: TOKEN }))).toEqual({ op: `revoke`, token: TOKEN });
    });

    // A short token is one a page could guess; the app mints 64 hex characters (local.rs `token`).
    it(`refuses a token too short to be secret, and anything it does not know`, () => {
        expect(parseControlLine(JSON.stringify({ op: `revoke`, token: `short` }))).toHaveProperty(`error`);
        expect(parseControlLine(JSON.stringify({ op: `grant`, token: TOKEN, id: `w1`, path: `/x`, kind: `device` }))).toHaveProperty(`error`);
        expect(parseControlLine(JSON.stringify({ op: `serve-everything` }))).toHaveProperty(`error`);
        expect(parseControlLine(`not json`)).toEqual({ error: `not JSON: not json` });
    });
});

describe(`controlLine`, () => {
    it(`is one JSON object per line`, () => {
        expect(controlLine({ event: `ready`, port: 4100, version: `1.2.3` })).toBe(`{"event":"ready","port":4100,"version":"1.2.3"}\n`);
    });
});
