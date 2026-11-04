import { ACCOUNT_ID_PATTERN, type User } from "@intentic/api-contract";
import { t } from "@intentic/ui/i18n";
import { accountOfSession, deviceAccountsOf, type LocalDeviceAccount, refusalOf } from "@intentic/web/local-host";
import { invoke } from "@tauri-apps/api/core";
import { type AccountAnswer, type AccountAsk, accountRelay, signIn, workspaceOpen } from "./desktop";

// THE ACCOUNT, AS A LOCAL WINDOW ASKS FOR IT (the web's localHost.ts `account`, `updateAccount`, `signOut`, and the
// other accounts signed in beside it): Better Auth's own calls, sent by the app with the workspace's session
// (src-tauri/src/account.rs), and their answers read the way the editor's auth client reads them (the web's
// client/auth/useAuth.ts).

type Relay = (ask: AccountAsk) => Promise<AccountAnswer>;

const GET_SESSION = `/api/auth/get-session`;
const DEVICE_ACCOUNTS = `/api/auth/multi-session/list-device-sessions`;
const SET_ACTIVE = `/api/auth/multi-session/set-active`;
const REVOKE = `/api/auth/multi-session/revoke`;

// allow(module-state): the account this window last read as signed in, one per window as the web's useAccount.ts keeps it
let drawnFor: string | undefined;

/** A call as this window sends it: one that changes something names the account the window last read as signed in, so
 *  the platform refuses it once the workspace has moved to someone else, rather than acting on the wrong person.
 *  Before the window has read anyone, nothing is named. */
export const meantFor = (ask: AccountAsk): AccountAsk => (ask.method === `POST` && drawnFor !== undefined ? { ...ask, account: drawnFor } : ask);

/** The app's relay as this window's other account calls take it (local/platform.ts: tokens, the plan, the sandboxes). */
export const windowRelay: Relay = (ask) => accountRelay(meantFor(ask));

const answered = (answer: AccountAnswer, otherwise: string): void => {
    if (answer.status < 200 || answer.status >= 300) {
        throw new Error(refusalOf(answer.body) ?? otherwise);
    }
};

export const readAccount = async (relay: Relay = accountRelay): Promise<User | null> => {
    const answer = await relay({ method: `GET`, path: GET_SESSION });
    answered(answer, t(`desktop.account.sessionCheckFailed`));
    const user = accountOfSession(answer.body);
    // An id the app would refuse the whole call for is not named: such a call goes as it went before there were several
    // accounts.
    drawnFor = user !== null && ACCOUNT_ID_PATTERN.test(user.id) ? user.id : undefined;
    return user;
};

/** Every account signed in where the workspace signs in, as the platform lists them now; none while nobody is. */
export const readDeviceAccounts = async (relay: Relay = accountRelay): Promise<readonly LocalDeviceAccount[]> => {
    const answer = await relay({ method: `GET`, path: DEVICE_ACCOUNTS });
    if (answer.status === 401) {
        return [];
    }
    answered(answer, t(`desktop.account.sessionCheckFailed`));
    return deviceAccountsOf(answer.body);
};

/** Makes the account `token` names the one signed in; the app reloads the workspace as it (account.rs). */
export const switchAccount = async (token: string, relay: Relay = accountRelay): Promise<void> => {
    const ask: AccountAsk = { method: `POST`, path: SET_ACTIVE, body: JSON.stringify({ sessionToken: token }) };
    answered(await relay(meantFor(ask)), t(`desktop.account.switchFailed`));
};

/** Signs out of the account `token` names alone; the platform carries on as another still signed in when it was the
 *  one signed in now, and the app reloads the workspace as that one (account.rs). */
export const revokeAccount = async (token: string, relay: Relay = accountRelay): Promise<void> => {
    const ask: AccountAsk = { method: `POST`, path: REVOKE, body: JSON.stringify({ sessionToken: token }) };
    answered(await relay(meantFor(ask)), t(`desktop.account.signOutFailed`));
};

/** Whether the session this app holds is still one the platform takes, asked now: false is nobody (no session, or one
 *  turned away), undefined is nothing to go by (the platform out of reach, an answer that is not a session). Asking
 *  is also how the app learns it (account.rs `account_relay`), so the roster every window draws by follows. */
export const sessionHolds = async (relay: Relay = accountRelay): Promise<boolean | undefined> => {
    let answer: AccountAnswer;
    try {
        answer = await relay({ method: `GET`, path: GET_SESSION });
    } catch (error) {
        console.warn(`[account] the session could not be checked:`, error);
        return undefined;
    }
    if (answer.status === 401 || (answer.status >= 200 && answer.status < 300 && answer.body.trim() === `null`)) {
        return false;
    }
    if (answer.status < 200 || answer.status >= 300) {
        return undefined;
    }
    return accountOfSession(answer.body) === null ? undefined : true;
};

/** Into the workspace at `path`, or a sign-in first when the session is gone, asked at the press: the roster can be
 *  behind a session that lapsed since, and the workspace would only open on its sign-in wall. The sign-in moves nobody
 *  when it returns (auth.rs): the reader presses again once its tile says it is done. Nothing to go by (offline) goes
 *  in, and the workspace says why. */
export const intoWorkspace = async (path: string): Promise<void> => {
    await ((await sessionHolds()) === false ? signIn() : workspaceOpen(path));
};

/** A sandbox of THIS computer, from Devices: as {@link intoWorkspace} while it has a workspace row at `path`, the app
 *  then opening the face on it (`key`, its key there) rather than the workspace when the workspace does not answer
 *  (machine_face.rs `local_sandbox_open`). One the platform never named has no row and no sign-in to ask about: it
 *  opens in the face. */
export const intoLocalSandbox = async (path: string | undefined, key: string): Promise<void> => {
    await (path !== undefined && (await sessionHolds()) === false ? signIn() : invoke(`local_sandbox_open`, { path: path ?? null, sandbox: key }));
};

export const updateAccount = async (change: { readonly name?: string; readonly image?: string }, relay: Relay = accountRelay): Promise<void> => {
    answered(await relay(meantFor({ method: `POST`, path: `/api/auth/update-user`, body: JSON.stringify(change) })), t(`desktop.account.profileUpdateFailed`));
};

/** Signs out of every account signed in where the workspace signs in. */
export const signOutAccount = async (relay: Relay = accountRelay): Promise<void> => {
    answered(await relay(meantFor({ method: `POST`, path: `/api/auth/sign-out`, body: `{}` })), t(`desktop.account.signOutFailed`));
};
