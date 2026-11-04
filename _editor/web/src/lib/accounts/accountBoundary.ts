import { ACCOUNT_CHANGED, ACCOUNT_HEADER, type User } from "@intentic/api-contract";
import { noteReload } from "@intentic/ui/reload-reason";
import { t } from "@intentic/ui/i18n";
import { z } from "zod";
import { reloadOnHotUpdate } from "../../app/hotReload";
import { localFace } from "../../app/environments/local";
import { accountPartition, openAccountPartition, sealAccountWrites } from "../../app/storage/browserStorage";
import { announceAccountChanged, onAccountChangedElsewhere } from "../authLifecycle";

// THE ACCOUNT BOUNDARY: a page is drawn for exactly one account for its whole life, and the move to another is a full
// navigation. A browser can be signed in to several accounts (client/auth/deviceAccounts.ts), and only one of them is
// active, in a cookie every tab shares; so the account can change under a page by many roads (a switch here or in
// another tab, adding one, signing one out and carrying on as the next, a session ending, the desktop app's relay), and
// every road ends here. Three things follow from it:
//
// - STORAGE: the page reads and writes its account's own drawer (@intentic/ui/storage). Which drawer is read before the
//   page knows who is signed in, from the browser's pointer, since stores read their keys at import; `enterAccount`
//   corrects it once the platform has said, reloading when what was already read was someone else's.
// - NETWORK: every platform call that changes something says which account it is meant for, and every answer says which
//   account it was made as (ACCOUNT_HEADER). A call the platform refused as meant for someone else, or an answer made as
//   someone else, never reaches a view: it throws, and the page finds out who is signed in now.
// - OTHER TABS: a tab that moves the browser says so, and every other tab goes Home as the account now active.
//
// Nothing here tears an account's traces down (client/auth/accountTeardown.ts does), so this module stays at the bottom
// of the auth graph: the platform client and the credential layers import it, never the other way round.

/** A platform answer, or a call about to be sent, that belongs to an account this page is not drawn for. */
export class AccountChangedError extends Error {
    constructor() {
        super(t(`auth.accounts.changedElsewhere`));
        this.name = `AccountChangedError`;
    }
}

/** The account a page is drawn for, as much of it as the layers under the account need. */
export interface PageAccount {
    readonly id: string;
    readonly email: string;
}

// allow(module-state): the one account this page is drawn for, fixed for its life once entered
let held: PageAccount | undefined;
// allow(module-state): whether this page is on its way to another account, after which it sends the platform nothing
let leaving = false;
// allow(module-state): how the page finds out who is signed in after an answer said it is someone else (useAuth's refresh)
let reconciler: (() => Promise<void>) | undefined;
let reconciling: Promise<void> | undefined;

/** The account this page is drawn for; undefined before the platform said, in a local window, or once it has gone. */
export const pageAccount = (): PageAccount | undefined => held;

// Where a navigation lands, held to this app's own scheme and host: a destination read off an address (`?returnTo=`,
// lib/routes/signIn.ts) that resolves anywhere else goes Home instead. The URL parser drops a tab or a newline, so
// `/\t/evil.example` is `//evil.example` to it, and a rooted-path check alone lets that through. The result is rebuilt on
// the page's own prefix rather than handed back as a path, since a path can still open `//` once its dot segments go.
const withinApp = (destination: string): string => {
    const here = globalThis.location;
    const own = `${here.protocol}//${here.host}`;
    const url = new URL(destination, `${own}/`);
    return url.protocol === here.protocol && url.host === here.host ? `${own}${url.pathname}${url.search}${url.hash}` : `${own}/`;
};

// The full navigation every road takes: nothing drawn, cached or in flight for one account survives into the next.
const go = (destination: string | undefined): void => {
    if (destination === undefined) {
        globalThis.location.reload();
        return;
    }
    globalThis.location.href = withinApp(destination);
};

// Stops this page acting for the account it was drawn for: no more writes into a drawer that is not the browser's now,
// no more platform calls riding a cookie that is someone else's.
const stopActing = (): void => {
    sealAccountWrites();
    leaving = true;
};

// allow(module-state): the account the workspace shell was drawn for in this page, and whether the shell is up right now
let drawnFor: string | undefined;
let inShell = false;
// allow(module-state): whether this page may hold another account's state: read at import from a drawer that was not the
// one now open, or drawn for someone else. Such a page enters the shell only by a full navigation.
let stale = false;

// Reloads this page now, as a reload nobody pressed for: the tab's budget may refuse it (reloadReason.ts), and then the
// page stays as it is rather than reloading in a loop.
const reloadNow = (account: string, destination: string | undefined): boolean => {
    if (!noteReload(`account-change`, { account })) {
        console.warn(`[accounts] this tab reloaded itself too often to change account by reloading again`);
        return false;
    }
    stopActing();
    go(destination);
    return true;
};

/**
 * Takes `user` as the account this page is drawn for, once the platform has said who is signed in: opens its drawer,
 * adopting what nobody's drawer held. A page showing the workspace shell drawn for someone else, or from a drawer that
 * is not this account's, reloads at once and answers `reloading`: it draws nothing more. A page outside the shell (signing
 * in, handing a sign-in to the desktop app) follows the account in place, and enters the shell by a full navigation
 * (`enterShell`). A local window has no account of its own to draw (useAccount.ts), so nothing changes there.
 */
export const enterAccount = (user: Pick<User, `id` | `email`>): `entered` | `reloading` => {
    if (localFace() !== undefined) {
        return `entered`;
    }
    if (leaving) {
        return `reloading`;
    }
    const before = held;
    const opened = openAccountPartition(user.id);
    held = { id: user.id, email: user.email };
    stale ||= opened.stale || (before !== undefined && before.id !== user.id) || (drawnFor !== undefined && drawnFor !== user.id);
    if (stale && inShell && reloadNow(user.id, undefined)) {
        return `reloading`;
    }
    return `entered`;
};

/**
 * The shell's entry for a page that knows who is signed in (router/sessionGuard.ts): true to go on, false when this page
 * may hold another account's state and has started a full navigation to `destination` instead.
 */
export const enterShell = (destination: string): boolean => {
    if (held === undefined) {
        return true;
    }
    if (stale && reloadNow(held.id, destination)) {
        return false;
    }
    drawnFor = held.id;
    return true;
};

/** Whether the route now shown is inside the workspace shell, said by the router after every navigation. */
export const noteShellRoute = (shell: boolean): void => {
    inShell = shell;
};

/**
 * Leaves this page for another account (undefined: nobody), at `destination`: points the browser at it, tells every other
 * tab, and navigates. The caller has already done what the platform needs (set the account active, or signed one out).
 */
export const leaveFor = (next: Pick<User, `id`> | undefined, destination: string): void => {
    openAccountPartition(next?.id);
    stopActing();
    held = undefined;
    announceAccountChanged(next?.id);
    noteReload(next === undefined ? `sign-out` : `account-switch`);
    go(destination);
};

/** Points the browser at no account and stops this page acting for its own: every account here was signed out. */
export const leaveForNobody = (): void => {
    openAccountPartition(undefined);
    stopActing();
    held = undefined;
};

/** Forgets the account this page was drawn for, its session having ended: the next account entered is a new one. */
export const releaseAccount = (): void => {
    held = undefined;
};

/** Who finds out the account now signed in, when an answer says it is not this page's. */
export const setAccountReconciler = (reconcile: () => Promise<void>): void => {
    reconciler = reconcile;
};

// Once per mismatch however many answers carry it: one ask of the platform, which ends in `enterAccount`.
const reconcile = (): void => {
    reconciling ??= (async () => {
        try {
            await reconciler?.();
        } catch (error) {
            console.warn(`[accounts] who is signed in now could not be asked:`, error);
        } finally {
            reconciling = undefined;
        }
    })();
};

/** The header a platform call that changes something carries: the account this page is drawn for. */
export const accountExpectation = (method: string): Readonly<Record<string, string>> =>
    held === undefined || method === `GET` || method === `HEAD` ? {} : { [ACCOUNT_HEADER]: held.id };

/** Refuses to send anything for a page on its way to another account. */
export const assertAccountCurrent = (): void => {
    if (leaving) {
        throw new AccountChangedError();
    }
};

const RefusalSchema = z.object({ code: z.literal(ACCOUNT_CHANGED) });

// Whether a 409 is the platform's account refusal rather than a conflict of the call's own.
const refusedAsChanged = async (response: Response): Promise<boolean> => {
    if (response.status !== 409) {
        return false;
    }
    try {
        return RefusalSchema.safeParse(await response.clone().json()).success;
    } catch {
        // allow(silent-catch): a 409 whose body is not JSON is some other conflict, the caller's to read.
        return false;
    }
};

/**
 * Checks a platform answer was made for this page's account: one made as someone else, or refused as meant for someone
 * else, throws AccountChangedError and has the page find out who is signed in now. An answer naming nobody is the
 * platform's to say (a 401, which the caller reads).
 */
export const checkAnswerAccount = async (response: Response): Promise<void> => {
    if (leaving) {
        throw new AccountChangedError();
    }
    const answeredAs = response.headers.get(ACCOUNT_HEADER);
    const mismatched = held !== undefined && answeredAs !== null && answeredAs !== held.id;
    if (mismatched || (await refusedAsChanged(response))) {
        reconcile();
        throw new AccountChangedError();
    }
};

// Another tab moved the browser: this page goes Home as whoever is active now, since its own address may name a sandbox
// that account cannot open. A page already drawn for that account (or a local window) has nowhere to go.
onAccountChangedElsewhere((account) => {
    if (localFace() !== undefined || leaving || (held !== undefined && held.id === account)) {
        return;
    }
    if (held === undefined && accountPartition() === account) {
        return;
    }
    if (!noteReload(`account-change`, { account: account ?? `nobody` })) {
        return;
    }
    stopActing();
    go(`/`);
});

/** For tests: this page drawn for nobody, and not leaving. */
export const resetAccountBoundaryForTests = (): void => {
    held = undefined;
    leaving = false;
    drawnFor = undefined;
    inShell = false;
    stale = false;
    reconciler = undefined;
    reconciling = undefined;
};

// One account per page, as useAuth keeps one user: a hot update re-running this module would forget whom it is drawn for.
reloadOnHotUpdate(import.meta);
