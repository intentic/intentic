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

    // The server answers a key whose session it closed with "Version changed" for five minutes, and after that with the
    // conversion it made when the session began: the edits gone.
    it(`never hands out a key again once the server closed its session with the final save`, () => {
        const sessions = new Sessions();
        const session = shared(sessions);
        sessions.saved(session.key, stat(150, 3000));
        sessions.closed(session.key);
        const reopened = shared(sessions, `brief.docx`, stat(150, 3000));
        expect(reopened.key).not.toBe(session.key);
        expect(reopened.key).toMatch(/^[0-9A-Za-z._=-]{1,128}$/);
        // The document behind the old key is still where a late fetch of it looks.
        expect(sessions.document(session.key)).toEqual({ path: `brief.docx`, agent: undefined });
        // Not even when the bytes never moved (a final save that wrote nothing): the next key steps past the closed one.
        const unmoved = shared(sessions, `other.docx`, stat(7, 7));
        sessions.closed(unmoved.key);
        const again = shared(sessions, `other.docx`, stat(7, 7));
        expect(again.key).not.toBe(unmoved.key);
        expect(shared(sessions, `other.docx`, stat(7, 7)).key).toBe(again.key);
        sessions.closed(`unknown`);
        expect(sessions.document(`unknown`)).toBeUndefined();
    });

    it(`keys a conversation's copy fresh every open and never lets it be saved`, () => {
        const sessions = new Sessions();
        const one = sessions.open({ path: `brief.docx`, agent: `conv-1`, mode: `edit`, theme: `dark`, stat: undefined });
        const two = sessions.open({ path: `brief.docx`, agent: `conv-1`, mode: `edit`, theme: `dark`, stat: undefined });
        expect(one.key).not.toBe(two.key);
        expect(sessions.document(one.key)).toEqual({ path: `brief.docx`, agent: `conv-1` });
    });

    it(`keys a conversation's copy by its bytes when they are known, so the same bytes find the same conversion`, () => {
        const sessions = new Sessions();
        const copy = (digest: string): ReturnType<Sessions[`open`]> =>
            sessions.open({ path: `brief.docx`, agent: `conv-1`, mode: `view`, theme: `light`, stat: undefined, digest });
        const first = copy(`abc`);
        expect(copy(`abc`).key).toBe(first.key);
        expect(copy(`def`).key).not.toBe(first.key);
        // The same bytes in another conversation's copy are another document.
        const elsewhere = sessions.open({ path: `brief.docx`, agent: `conv-2`, mode: `view`, theme: `light`, stat: undefined, digest: `abc` });
        expect(elsewhere.key).not.toBe(first.key);
        expect(sessions.document(first.key)).toEqual({ path: `brief.docx`, agent: `conv-1` });
    });

    it(`stays inside ONLYOFFICE's key alphabet and length`, () => {
        const { key } = shared(new Sessions(), `reports/Q3 <final>.xlsx`);
        expect(key).toMatch(/^[0-9A-Za-z._=-]{1,128}$/);
    });
});

describe(`an editor kept alive`, () => {
    const input = (at = stat(100, 1000), run = 1): Parameters<Sessions[`current`]>[1] => ({
        path: `brief.docx`,
        agent: undefined,
        mode: `edit`,
        theme: `light`,
        stat: at,
        run,
    });

    it(`is current while it holds what an open would get, on the same run of the server`, () => {
        const sessions = new Sessions();
        const kept = sessions.open(input());
        expect(sessions.current(kept.token, input())).toBe(true);
        // Its own forced save moved the file: still the same session.
        sessions.saved(kept.key, stat(120, 2000));
        expect(sessions.current(kept.token, input(stat(120, 2000)))).toBe(true);
        // Someone else changed the file, or the server restarted and lost the session.
        expect(sessions.current(kept.token, input(stat(130, 3000)))).toBe(false);
        expect(sessions.current(kept.token, input(stat(120, 2000), 2))).toBe(false);
        // Another document, another mode, a token nobody issued.
        expect(sessions.current(kept.token, { ...input(stat(120, 2000)), path: `other.docx` })).toBe(false);
        expect(sessions.current(kept.token, { ...input(stat(120, 2000)), mode: `view` })).toBe(false);
        expect(sessions.current(`never-issued`, input())).toBe(false);
    });

    it(`is not current once the server closed its session`, () => {
        const sessions = new Sessions();
        const kept = sessions.open(input());
        sessions.closed(kept.key);
        expect(sessions.current(kept.token, input())).toBe(false);
    });

    it(`moves onto a fresh key under the same token when the server calls its key outdated`, () => {
        const sessions = new Sessions();
        const session = sessions.open(input());
        const renewed = sessions.renew(session.token, input(stat(100, 1000), 3));
        expect(renewed).toMatchObject({ token: session.token, path: `brief.docx`, mode: `edit`, run: 3 });
        const key = renewed?.key ?? ``;
        expect(key).not.toBe(session.key);
        expect(key).toMatch(/^[0-9A-Za-z._=-]{1,128}$/);
        expect(sessions.session(session.token)).toEqual(renewed);
        // The new key is the one the next open of these bytes joins.
        expect(sessions.open(input(stat(100, 1000), 3)).key).toBe(key);
        expect(sessions.renew(`never-issued`, input())).toBeUndefined();
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
