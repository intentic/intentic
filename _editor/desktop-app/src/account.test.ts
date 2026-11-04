import type { User } from "@intentic/api-contract";
import { meantFor, readAccount, readDeviceAccounts, revokeAccount, sessionHolds, signOutAccount, switchAccount, updateAccount } from "./account";
import type { AccountAnswer, AccountAsk } from "./desktop";

// The app's carrying of the call is account.rs's (and its tests'); this is the page's half: what it asks, and how it
// reads what the platform answered. No catalog is registered here, so the app's own sentence reads back as its key.

const asked: AccountAsk[] = [];
const answering =
    (status: number, body: string) =>
    (ask: AccountAsk): Promise<AccountAnswer> => {
        asked.push(ask);
        return Promise.resolve({ status, body, contentType: `application/json` });
    };

// Each case starts with the window having read nobody, so no call it makes is meant for anyone yet.
beforeEach(async () => {
    await readAccount(answering(200, `null`));
    asked.length = 0;
});

// Better Auth's own get-session answer, with a field of its user the editor does not keep (emailVerified) beside one it
// does (createdAt, which tells analytics a sign-up from a return).
const SESSION = {
    session: { id: `s1`, userId: `u1`, expiresAt: `2026-10-10T00:00:00.000Z`, token: `never-read` },
    user: { id: `u1`, email: `ada@example.com`, name: `Ada`, image: `https://example.com/ada.png`, emailVerified: true, createdAt: `2026-01-01T00:00:00.000Z` },
};

describe(`readAccount`, () => {
    it(`is the session's user, as the editor's User and no more`, async () => {
        const user: User = {
            id: `u1`,
            email: `ada@example.com`,
            name: `Ada`,
            image: `https://example.com/ada.png`,
            createdAt: `2026-01-01T00:00:00.000Z`,
        };
        expect(await readAccount(answering(200, JSON.stringify(SESSION)))).toStrictEqual(user);
        expect(asked).toEqual([{ method: `GET`, path: `/api/auth/get-session` }]);
    });

    it(`is a user with no name or picture, with both empty`, async () => {
        const bare = { ...SESSION, user: { id: `u1`, email: `ada@example.com`, name: null } };
        expect(await readAccount(answering(200, JSON.stringify(bare)))).toStrictEqual({ id: `u1`, email: `ada@example.com`, name: ``, image: null });
    });

    it(`is nobody when the platform says so, and when its answer is out of shape`, async () => {
        expect(await readAccount(answering(200, `null`))).toBeNull();
        expect(await readAccount(answering(200, JSON.stringify({ user: { id: `u1` } })))).toBeNull();
    });

    it(`rejects with the platform's sentence, or its own when the answer has none`, async () => {
        await expect(readAccount(answering(500, JSON.stringify({ message: `Database is waking up.` })))).rejects.toThrow(`Database is waking up.`);
        await expect(readAccount(answering(502, `<html>Bad gateway</html>`))).rejects.toThrow(`desktop.account.sessionCheckFailed`);
    });
});

describe(`sessionHolds`, () => {
    it(`holds for a session with a user, and not for nobody or a refused one`, async () => {
        expect(await sessionHolds(answering(200, JSON.stringify(SESSION)))).toBe(true);
        expect(await sessionHolds(answering(200, `null`))).toBe(false);
        expect(await sessionHolds(answering(401, `{"message":"Not signed in."}`))).toBe(false);
    });

    it(`has nothing to go by when the platform is down, unreachable, or answers out of shape`, async () => {
        expect(await sessionHolds(answering(502, `<html>Bad gateway</html>`))).toBeUndefined();
        expect(await sessionHolds(answering(200, JSON.stringify({ user: { id: `u1` } })))).toBeUndefined();
        jest.spyOn(console, `warn`).mockImplementation(() => undefined);
        expect(await sessionHolds(() => Promise.reject(new Error(`offline`)))).toBeUndefined();
    });
});

describe(`updateAccount and signOutAccount`, () => {
    it(`send Better Auth's own calls, the change as its JSON body`, async () => {
        await updateAccount({ name: `Ada L.` }, answering(200, `{"status":true}`));
        await signOutAccount(answering(200, `{"success":true}`));
        expect(asked).toEqual([
            { method: `POST`, path: `/api/auth/update-user`, body: `{"name":"Ada L."}` },
            { method: `POST`, path: `/api/auth/sign-out`, body: `{}` },
        ]);
    });

    it(`reject with what the platform refused them for`, async () => {
        await expect(updateAccount({ image: `data:,x` }, answering(400, JSON.stringify({ message: `That picture is too large.` })))).rejects.toThrow(
            `That picture is too large.`,
        );
        await expect(signOutAccount(answering(401, `{}`))).rejects.toThrow(`desktop.account.signOutFailed`);
    });
});

describe(`the other accounts signed in beside this one`, () => {
    const BO = { id: `u2`, email: `bo@example.com`, name: `Bo`, image: null };

    it(`are listed as the platform lists them, an entry out of shape left out`, async () => {
        const listed = [SESSION, { session: { token: `t2` }, user: BO }, { session: {}, user: BO }];
        expect(await readDeviceAccounts(answering(200, JSON.stringify(listed)))).toStrictEqual([
            { token: `never-read`, user: { id: `u1`, email: `ada@example.com`, name: `Ada`, image: `https://example.com/ada.png`, createdAt: `2026-01-01T00:00:00.000Z` } },
            { token: `t2`, user: BO },
        ]);
        expect(asked).toEqual([{ method: `GET`, path: `/api/auth/multi-session/list-device-sessions` }]);
    });

    it(`are none while nobody is signed in, and reject when the platform is in trouble`, async () => {
        expect(await readDeviceAccounts(answering(401, `{"message":"Not signed in."}`))).toEqual([]);
        await expect(readDeviceAccounts(answering(502, `<html>Bad gateway</html>`))).rejects.toThrow(`desktop.account.sessionCheckFailed`);
    });

    it(`are switched to and signed out of by their token, each refusal said as the platform said it`, async () => {
        await switchAccount(`t2`, answering(200, JSON.stringify({ session: { token: `t2` }, user: BO })));
        await revokeAccount(`t1`, answering(200, `{"status":true}`));
        expect(asked).toEqual([
            { method: `POST`, path: `/api/auth/multi-session/set-active`, body: `{"sessionToken":"t2"}` },
            { method: `POST`, path: `/api/auth/multi-session/revoke`, body: `{"sessionToken":"t1"}` },
        ]);
        await expect(switchAccount(`t9`, answering(401, `{"message":"Invalid session token"}`))).rejects.toThrow(`Invalid session token`);
        await expect(revokeAccount(`t9`, answering(500, `{}`))).rejects.toThrow(`desktop.account.signOutFailed`);
        await expect(switchAccount(`t9`, answering(500, `{}`))).rejects.toThrow(`desktop.account.switchFailed`);
    });
});

describe(`the account a call is meant for`, () => {
    it(`is the one the window last read, on every call that changes something and none that only reads`, async () => {
        await readAccount(answering(200, JSON.stringify(SESSION)));
        await updateAccount({ name: `Ada L.` }, answering(200, `{"status":true}`));
        await revokeAccount(`never-read`, answering(200, `{"status":true}`));
        await readDeviceAccounts(answering(200, `[]`));
        expect(asked.slice(1)).toEqual([
            { method: `POST`, path: `/api/auth/update-user`, body: `{"name":"Ada L."}`, account: `u1` },
            { method: `POST`, path: `/api/auth/multi-session/revoke`, body: `{"sessionToken":"never-read"}`, account: `u1` },
            { method: `GET`, path: `/api/auth/multi-session/list-device-sessions` },
        ]);
        // The account's other calls, as local/platform.ts carries them.
        expect(meantFor({ method: `POST`, path: `/rpc/tokens/create`, body: `{}` })).toEqual({ method: `POST`, path: `/rpc/tokens/create`, body: `{}`, account: `u1` });
        expect(meantFor({ method: `GET`, path: `/rpc/tokens` })).toEqual({ method: `GET`, path: `/rpc/tokens` });
    });

    it(`is nobody once the window reads nobody, or an id the app would refuse the call for`, async () => {
        await readAccount(answering(200, JSON.stringify(SESSION)));
        await readAccount(answering(200, `null`));
        expect(meantFor({ method: `POST`, path: `/api/auth/sign-out`, body: `{}` })).toEqual({ method: `POST`, path: `/api/auth/sign-out`, body: `{}` });
        await readAccount(answering(200, JSON.stringify({ ...SESSION, user: { ...SESSION.user, id: `u 1` } })));
        expect(meantFor({ method: `POST`, path: `/api/auth/sign-out`, body: `{}` })).toEqual({ method: `POST`, path: `/api/auth/sign-out`, body: `{}` });
    });
});
