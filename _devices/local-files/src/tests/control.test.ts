import { type ControlMessage, controlLine, parseControlLine } from "../control.js";

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

    // A grant's limits (grants.ts): nothing written, a handoff to exact origins, an end.
    it(`reads a grant's limits`, () => {
        const grant: ControlMessage = {
            op: `grant`,
            token: TOKEN,
            id: `w1`,
            path: `/home/me/brief.docx`,
            kind: `file`,
            readOnly: true,
            origins: [`https://app.intentic.dev`],
            expiresInMs: 60_000,
        };
        expect(parseControlLine(JSON.stringify(grant))).toEqual(grant);
    });

    // An origin is a scheme and a host: anything more (a path, a wildcard) would widen what the handoff opens.
    it(`refuses a handoff to something that is not an exact origin`, () => {
        const grant = (origins: readonly string[]) => JSON.stringify({ op: `grant`, token: TOKEN, id: `w1`, path: `/x`, kind: `file`, origins });
        expect(parseControlLine(grant([`https://app.intentic.dev/`]))).toHaveProperty(`invalid`);
        expect(parseControlLine(grant([`*`]))).toHaveProperty(`invalid`);
        expect(parseControlLine(grant([`file:///etc`]))).toHaveProperty(`invalid`);
        expect(parseControlLine(grant([]))).toHaveProperty(`invalid`);
        expect(parseControlLine(JSON.stringify({ op: `grant`, token: TOKEN, id: `w1`, path: `/x`, kind: `file`, expiresInMs: 0 }))).toHaveProperty(
            `invalid`,
        );
    });

    it(`reads the app's answer to an ask, and the office prefetch`, () => {
        expect(parseControlLine(`{"op":"answer","id":"a1","ok":true}`)).toEqual({ op: `answer`, id: `a1`, ok: true });
        expect(parseControlLine(`{"op":"answer","id":"a1","ok":false,"error":"The Trash is full."}`)).toEqual({
            op: `answer`,
            id: `a1`,
            ok: false,
            error: `The Trash is full.`,
        });
        expect(parseControlLine(`{"op":"prefetch-office"}`)).toEqual({ op: `prefetch-office` });
    });

    // A short token is one a page could guess; the app mints 64 hex characters (local.rs `token`).
    it(`refuses a token too short to be secret, and anything it does not know`, () => {
        expect(parseControlLine(JSON.stringify({ op: `revoke`, token: `short` }))).toHaveProperty(`invalid`);
        expect(parseControlLine(JSON.stringify({ op: `grant`, token: TOKEN, id: `w1`, path: `/x`, kind: `device` }))).toHaveProperty(`invalid`);
        expect(parseControlLine(JSON.stringify({ op: `serve-everything` }))).toHaveProperty(`invalid`);
        expect(parseControlLine(`not json`)).toEqual({ invalid: `not JSON: not json` });
    });
});

describe(`controlLine`, () => {
    it(`is one JSON object per line`, () => {
        expect(controlLine({ event: `ready`, port: 4100, version: `1.2.3` })).toBe(`{"event":"ready","port":4100,"version":"1.2.3"}\n`);
    });

    // The two lines the app answers or waits for, exactly as it reads them.
    it(`writes an ask and where the office download ended`, () => {
        expect(controlLine({ event: `ask`, id: `a1`, verb: `trash`, path: `/home/me/project/old.txt` })).toBe(
            `{"event":"ask","id":"a1","verb":"trash","path":"/home/me/project/old.txt"}\n`,
        );
        expect(controlLine({ event: `office`, state: `ready` })).toBe(`{"event":"office","state":"ready"}\n`);
        expect(controlLine({ event: `office`, state: `failed`, error: `offline` })).toBe(`{"event":"office","state":"failed","error":"offline"}\n`);
    });
});
