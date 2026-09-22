import { describe, it, expect } from "bun:test";
import { Sessions } from "./sessions.js";

const stat = (size: number, mtimeMs: number): { size: number; mtimeMs: number } => ({ size, mtimeMs });
const shared = (sessions: Sessions, file = `brief.docx`, at = stat(100, 1000)): ReturnType<Sessions[`open`]> =>
    sessions.open({ path: file, agent: undefined, mode: `edit`, theme: `light`, stat: at });

describe(`document keys`, () => {
    it(`shares one key between two opens of the same bytes, so two tabs co-edit`, () => {
        const sessions = new Sessions();
        const first = shared(sessions);
        const second = shared(sessions);
        expect(second.key).toBe(first.key);
        expect(second.token).not.toBe(first.token);
    });

    it(`mints a new key once the file changed on disk under someone else's hand`, () => {
        const sessions = new Sessions();
        const before = shared(sessions);
        const after = shared(sessions, `brief.docx`, stat(120, 2000));
        expect(after.key).not.toBe(before.key);
        expect(sessions.document(after.key)).toEqual({ path: `brief.docx`, agent: undefined });
    });

    it(`keeps the key across its own save: the bytes the save left are the bytes the session holds`, () => {
        const sessions = new Sessions();
        const session = shared(sessions);
        sessions.saved(session.key, stat(150, 3000));
        expect(shared(sessions, `brief.docx`, stat(150, 3000)).key).toBe(session.key);
        // A save under a key nothing opened is ignored rather than inventing a document.
        sessions.saved(`unknown`, stat(1, 1));
        expect(sessions.document(`unknown`)).toBeUndefined();
    });

    it(`keys a conversation's copy fresh every open and never lets it be saved`, () => {
        const sessions = new Sessions();
        const one = sessions.open({ path: `brief.docx`, agent: `conv-1`, mode: `edit`, theme: `dark`, stat: undefined });
        const two = sessions.open({ path: `brief.docx`, agent: `conv-1`, mode: `edit`, theme: `dark`, stat: undefined });
        expect(one.key).not.toBe(two.key);
        expect(sessions.document(one.key)).toEqual({ path: `brief.docx`, agent: `conv-1` });
    });

    it(`stays inside ONLYOFFICE's key alphabet and length`, () => {
        const { key } = shared(new Sessions(), `reports/Q3 <final>.xlsx`);
        expect(key).toMatch(/^[0-9A-Za-z._=-]{1,128}$/);
    });
});

describe(`session tokens`, () => {
    it(`answers for a live token and forgets an expired one`, () => {
        let now = 1_000_000;
        const sessions = new Sessions(() => now);
        const session = shared(sessions);
        expect(sessions.session(session.token)).toEqual(session);
        now += 12 * 60 * 60 * 1000;
        expect(sessions.session(session.token)).toBeUndefined();
        expect(sessions.session(`never-issued`)).toBeUndefined();
    });
});
