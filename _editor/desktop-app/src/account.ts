import type { User } from "@intentic/api-contract";
import { t } from "@intentic/ui/i18n";
import { accountOfSession, refusalOf } from "@intentic/web/local-host";
import { invoke } from "@tauri-apps/api/core";
import { type AccountAnswer, type AccountAsk, accountRelay, signIn, workspaceOpen } from "./desktop";

// THE ACCOUNT, AS A LOCAL WINDOW ASKS FOR IT (the web's localHost.ts `account`, `updateAccount`, `signOut`): Better
// Auth's own three calls, sent by the app with the workspace's session (src-tauri/src/account.rs), and their answers
// read the way the editor's auth client reads them (the web's client/auth/useAuth.ts).

type Relay = (ask: AccountAsk) => Promise<AccountAnswer>;

const answered = (answer: AccountAnswer, otherwise: string): void => {
    if (answer.status < 200 || answer.status >= 300) {
        throw new Error(refusalOf(answer.body) ?? otherwise);
    }
};

export const readAccount = async (relay: Relay = accountRelay): Promise<User | null> => {
    const answer = await relay({ method: `GET`, path: `/api/auth/get-session` });
    answered(answer, t(`desktop.account.sessionCheckFailed`));
    return accountOfSession(answer.body);
};

/** Whether the session this app holds is still one the platform takes, asked now: false is nobody (no session, or one
 *  turned away), undefined is nothing to go by (the platform out of reach, an answer that is not a session). Asking
 *  is also how the app learns it (account.rs `account_relay`), so the roster every window draws by follows. */
export const sessionHolds = async (relay: Relay = accountRelay): Promise<boolean | undefined> => {
    let answer: AccountAnswer;
    try {
        answer = await relay({ method: `GET`, path: `/api/auth/get-session` });
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
    answered(await relay({ method: `POST`, path: `/api/auth/update-user`, body: JSON.stringify(change) }), t(`desktop.account.profileUpdateFailed`));
};

export const signOutAccount = async (relay: Relay = accountRelay): Promise<void> => {
    answered(await relay({ method: `POST`, path: `/api/auth/sign-out`, body: `{}` }), t(`desktop.account.signOutFailed`));
};
