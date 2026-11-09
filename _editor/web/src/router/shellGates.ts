import type { SandboxSummary } from "@intentic/api-contract";
import { sandboxOfSegment } from "@intentic/sandbox-contract/app-routes";
import type { RouteLocationNormalized, RouteLocationRaw, Router } from "vue-router";
import { t } from "@intentic/ui/i18n";
import { nothingToOpen } from "../app/environments/nothingToOpen";
import { openOnProject } from "../app/projectScope";
import { useAuth } from "../client/auth/useAuth";
import { ownsMissingSandboxes, rememberedAccount } from "../client/directory/deviceDirectory";
import { directMode } from "../client/directory/directState";
import { platformHealth } from "../lib/platform/platformHealth";
import { enterFromMemory } from "../features/sandbox/recovery/directMode";
import { useSandbox } from "../client/sandbox/useSandbox";
import { routeSegment, segmentOf, toHome, toTop } from "../lib/routes/links";
import { routeChoosesSandbox, sandboxEntryPath } from "../models/sandbox/sandboxScreen";
import { useNotifications } from "../workbench/notifications/notifications";
import { arriveOnSandbox, type SandboxArrivalRoute } from "./sandboxArrival";
import { memoryChoice, unavailable } from "./sessionGuard";
import { readSetupRedirect } from "./setupGate";

// THE WORKSPACE SHELL'S ENTRY GUARDS, after sign-in (sessionGuard.ts): whether there is a workspace to open, and which
// sandbox a link names. The rules are their modules' (setupGate.ts, app/environments/nothingToOpen.ts, sandboxArrival.ts); these
// bind them to the live account, sandbox list and notifications for the route table (index.ts).

// Gates the workspace shell on having a workspace to open; setupGate.ts owns the predicate. A list the platform could
// not give is not an empty one, so it never reads as "nothing to open" (it used to leave the page blank). And a list
// that offers nothing to open while this device remembers sandboxes of the account's own goes to recovery rather than
// onboarding (2026-10-02): a platform answering from a database that forgot them looks exactly like a new account.
export const requireSetup = async (to: RouteLocationNormalized): Promise<boolean | RouteLocationRaw> => {
    const asked = (to.redirectedFrom ?? to).path;
    const read = () =>
        withinBudget(readSetupRedirect(useSandbox(), to.path, useAuth().user.value !== null, asked), LIST_BUDGET_MS).then(
            (redirect) => ({ redirect }),
            // allow(silent-catch): any failure to list means the same thing here, the platform could not be asked.
            (error: Error) => {
                // A list that hung past the budget is the one failure no platform call reported, and the session's answer
                // just now read the platform as up: told here, so a window opened from memory on it still finds its way
                // back when the platform answers again (directMode.ts `onRecovered`).
                if (error instanceof ListTimeout) {
                    platformHealth.noteUnreachable();
                }
                return undefined;
            },
        );
    let result = await read();
    // The session answered but the list did not (a platform half up, or one that hangs): a device that remembers this
    // very account opens what it remembers, as it would with no session answer at all (sessionGuard.ts), and the outage
    // screen is for one that remembers nothing of it.
    if (result === undefined && enteredFromMemory(to)) {
        result = await read();
    }
    if (result === undefined) {
        return unavailable(to);
    }
    const setup = result.redirect;
    if (setup === undefined) {
        return true;
    }
    const account = useAuth().user.value;
    return account !== null && ownsMissingSandboxes(account.email) ? toTop(`recover`) : setup;
};

// A list the platform does not give within this long is one it could not give: before, a platform that hung rather than
// refused held the first paint on the splash with no end, the session check's own budget (sessionGuard.ts) long spent.
const LIST_BUDGET_MS = 10_000;

class ListTimeout extends Error {}

const withinBudget = <T>(work: Promise<T>, budgetMs: number): Promise<T> =>
    Promise.race([work, new Promise<T>((_resolve, reject) => setTimeout(() => reject(new ListTimeout(`the platform did not list in time`)), budgetMs))]);

// Whether the window could open on what this device remembers of the signed-in account. Not for another account than
// the one signed in, and not for a window already open that way, whose list is the remembered one already.
const enteredFromMemory = (to: RouteLocationNormalized): boolean => {
    const account = useAuth().user.value;
    if (account === null || directMode.value) {
        return false;
    }
    const remembered = rememberedAccount(account.email);
    if (platformHealth.state.value !== `up`) {
        platformHealth.noteUnreachable();
    }
    return enterFromMemory(remembered, memoryChoice(to)) !== undefined;
};

// The reader is told when a sandbox an address named is not one this account lists.
const reportMissing = (): void =>
    useNotifications().report({ tone: `info`, title: t(`sandbox.sandboxSwitcher.notOnAccount`), detail: t(`sandbox.sandboxSwitcher.notOnAccountDetail`) });

// A link naming a sandbox (`/?sandbox=<id>`) opens the shell on it, inside it rather than on Home (`landing`);
// sandboxArrival.ts owns the rule. After the gate, so the list it reads is the one the gate just fetched.
export const openNamedSandbox = (to: SandboxArrivalRoute): Promise<true | RouteLocationRaw> => {
    const { list, refresh, select } = useSandbox();
    return arriveOnSandbox(to, { list, refresh, select, missing: reportMissing, scope: openOnProject, landing: sandboxEntryPath });
};

/**
 * THE SANDBOX COMES FROM THE ADDRESS (2026-11-04): a route naming one (`/s/<sandbox>/…`, `/home/<sandbox>/…`, a floating
 * window's) makes it the active sandbox, so each tab shows the sandbox its address says and Back across a switch undoes
 * it. Taken only when the account lists it, the list asked again once past its cache as sandboxArrival.ts asks it for a
 * sandbox the desktop app has just made; any other is said to be not on the account, and the same page of the sandbox
 * open before is shown instead, or Home with none. A list that cannot be had is the shell gate's to say (settleGate), so
 * the address is taken as it stands meanwhile.
 *
 * The address names the sandbox by its name and the tail of its id (lib/routes/links.ts `segmentOf`), and one written
 * otherwise (the whole id an older link or the daemon's push carries, a name since changed) is replaced by the address
 * as it is written now, so the bar always shows the sandbox's current name.
 */
export const selectRouteSandbox = async (to: RouteLocationNormalized): Promise<true | RouteLocationRaw> => {
    const written = routeSegment(to);
    if (written === undefined) {
        return true;
    }
    const { sandboxes, activeSandboxId, list, refresh, select } = useSandbox();
    routeChoosesSandbox();
    const named = (rows: readonly SandboxSummary[]): SandboxSummary | undefined => sandboxOfSegment(written, rows);
    let rows: readonly SandboxSummary[] = sandboxes.value;
    let found = named(rows);
    if (found === undefined) {
        // allow(silent-catch): a list the platform could not give is said by the shell's gate, not here.
        const listed = await list().catch(() => undefined);
        // allow(silent-catch): as above.
        const fresh = listed === undefined || named(listed) !== undefined ? listed : await refresh().catch(() => undefined);
        if (fresh === undefined) {
            return true;
        }
        rows = fresh;
        found = named(fresh);
        if (found === undefined) {
            reportMissing();
            const before = activeSandboxId.value;
            return before === undefined || before === written || to.name === undefined || to.name === null
                ? toHome()
                : { name: to.name, params: { ...to.params, sandbox: segmentOf(before, fresh) }, query: to.query, hash: to.hash };
        }
    }
    if (activeSandboxId.value !== found.id) {
        select(found.id);
    }
    const current = segmentOf(found.id, rows);
    return current === written || to.name === undefined || to.name === null
        ? true
        : { name: to.name, params: { ...to.params, sandbox: current }, query: to.query, hash: to.hash };
};

/**
 * The same gate for every navigation made inside the shell, which the shell's own entry guards (index.ts) no longer see:
 * a switch is a navigation from one sandbox's address to another's. Entering the shell is theirs, after sign-in.
 */
export const installRouteSandbox = (router: Router): void => {
    router.beforeEach((to, from) => (from.matched[0]?.path === `/` ? selectRouteSandbox(to) : true));
};

// The shell's gate as it stands here (nothingToOpen.ts): a landing that is where the navigation already goes is no
// redirect, so the bare address with nothing to open arrives on Home once rather than twice.
export const settleGate = async (to: RouteLocationNormalized): Promise<boolean | RouteLocationRaw> => {
    const gate = nothingToOpen.settle(await requireSetup(to));
    return gate === to.path ? true : gate;
};
