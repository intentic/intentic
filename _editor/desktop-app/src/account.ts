import type { User } from "@intentic/api-contract";
import { t } from "@intentic/ui/i18n";
import { accountOfSession, refusalOf } from "@intentic/web/local-host";
import { type AccountAnswer, type AccountAsk, accountRelay } from "./desktop";

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

export const updateAccount = async (change: { readonly name?: string; readonly image?: string }, relay: Relay = accountRelay): Promise<void> => {
    answered(await relay({ method: `POST`, path: `/api/auth/update-user`, body: JSON.stringify(change) }), t(`desktop.account.profileUpdateFailed`));
};

export const signOutAccount = async (relay: Relay = accountRelay): Promise<void> => {
    answered(await relay({ method: `POST`, path: `/api/auth/sign-out`, body: `{}` }), t(`desktop.account.signOutFailed`));
};
