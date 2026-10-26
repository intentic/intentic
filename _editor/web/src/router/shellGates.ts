import type { RouteLocationNormalized, RouteLocationRaw } from "vue-router";
import { t } from "@intentic/ui/i18n";
import { nothingToOpen } from "../app/environments/nothingToOpen";
import { openOnProject } from "../app/projectScope";
import { useAuth } from "../client/auth/useAuth";
import { ownsMissingSandboxes } from "../client/directory/deviceDirectory";
import { useSandbox } from "../client/sandbox/useSandbox";
import { sandboxEntryPath } from "../models/sandbox/sandboxScreen";
import { useNotifications } from "../workbench/notifications/notifications";
import { arriveOnSandbox, type SandboxArrivalRoute } from "./sandboxArrival";
import { unavailable } from "./sessionGuard";
import { readSetupRedirect } from "./setupGate";

// THE WORKSPACE SHELL'S ENTRY GUARDS, after sign-in (sessionGuard.ts): whether there is a workspace to open, and which
// sandbox a link names. The rules are their modules' (setupGate.ts, app/environments/nothingToOpen.ts, sandboxArrival.ts); these
// bind them to the live account, sandbox list and notifications for the route table (index.ts).

// Gates the workspace shell on having a workspace to open; setupGate.ts owns the predicate. A list the platform could
// not give is not an empty one, so it never reads as "nothing to open" (it used to leave the page blank). And a list
// that offers nothing to open while this device remembers sandboxes of the account's own goes to recovery rather than
// onboarding (2026-10-02): a platform answering from a database that forgot them looks exactly like a new account.
export const requireSetup = async (to: RouteLocationNormalized): Promise<boolean | RouteLocationRaw> => {
    // allow(silent-catch): any failure to list means the same thing here, the platform could not be asked; the outage
    // screen says so and retries.
    const asked = (to.redirectedFrom ?? to).path;
    const result = await readSetupRedirect(useSandbox(), to.path, useAuth().user.value !== null, asked).then(
        (redirect) => ({ redirect }),
        () => undefined,
    );
    if (result === undefined) {
        return unavailable(to);
    }
    const setup = result.redirect;
    if (setup === undefined) {
        return true;
    }
    const account = useAuth().user.value;
    return account !== null && ownsMissingSandboxes(account.email) ? `/recover` : setup;
};

// A link naming a sandbox (`/?sandbox=<id>`) opens the shell on it, inside it rather than on Home (`landing`);
// sandboxArrival.ts owns the rule. After the gate, so the list it reads is the one the gate just fetched.
export const openNamedSandbox = (to: SandboxArrivalRoute): Promise<true | RouteLocationRaw> => {
    const { list, refresh, select } = useSandbox();
    const missing = (): void =>
        useNotifications().report({ tone: `info`, title: t(`sandbox.sandboxSwitcher.notOnAccount`), detail: t(`sandbox.sandboxSwitcher.notOnAccountDetail`) });
    return arriveOnSandbox(to, { list, refresh, select, missing, scope: openOnProject, landing: sandboxEntryPath });
};

// The shell's gate as it stands here (nothingToOpen.ts): a landing that is where the navigation already goes is no
// redirect, so the bare address with nothing to open arrives on Home once rather than twice.
export const settleGate = async (to: RouteLocationNormalized): Promise<boolean | RouteLocationRaw> => {
    const gate = nothingToOpen.settle(await requireSetup(to));
    return gate === to.path ? true : gate;
};
