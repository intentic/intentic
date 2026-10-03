import type { User } from "@intentic/api-contract";
import { readAccount, signOutAccount, updateAccount } from "./account";
import type { AccountAnswer, AccountAsk } from "./desktop";

// The app's carrying of the call is account.rs's (and its tests'); this is the page's half: what it asks, and how it
// reads what the platform answered.

const asked: AccountAsk[] = [];
const answering =
    (status: number, body: string) =>
    (ask: AccountAsk): Promise<AccountAnswer> => {
        asked.push(ask);
        return Promise.resolve({ status, body, contentType: `application/json` });
    };

beforeEach(() => {
    asked.length = 0;
});

// Better Auth's own get-session answer, with the fields of its user the editor does not keep.
const SESSION = {
    session: { id: `s1`, userId: `u1`, expiresAt: `2026-10-10T00:00:00.000Z`, token: `never-read` },
    user: { id: `u1`, email: `ada@example.com`, name: `Ada`, image: `https://example.com/ada.png`, emailVerified: true, createdAt: `2026-01-01T00:00:00.000Z` },
};

describe(`readAccount`, () => {
    it(`is the session's user, as the editor's User and no more`, async () => {
        const user: User = { id: `u1`, email: `ada@example.com`, name: `Ada`, image: `https://example.com/ada.png` };
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
        await expect(readAccount(answering(502, `<html>Bad gateway</html>`))).rejects.toThrow(`Couldn't check your session.`);
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
        await expect(signOutAccount(answering(401, `{}`))).rejects.toThrow(`Sign out failed.`);
    });
});
