import type { SandboxSummary } from "@intentic/api-contract";
import { messageOr } from "@intentic/ui/async";
import { t } from "@intentic/ui/i18n";
import { apiClient } from "../../lib/useApi";
import { useSandboxSession } from "../session/sandboxSession";

// LEAVING A SHARED SANDBOX IS TWO RECORDS, AND THE DAEMON'S IS THE ONE THAT GRANTS. The platform's row only says which
// sandboxes the switcher lists; the sandbox's own member list is what lets this person in, so a leave that only
// dropped the row left them able to open it. The daemon is asked first (`DELETE /members/self`, through the session
// that proves who is leaving, at that sandbox's own address, so any row can be left and not only the open one), then the
// platform's row goes.
//
// A sandbox that cannot be asked (asleep, offline, its session refused) does not keep the person from leaving their own
// account's list, which is theirs to tidy; it is said in the answer instead: its member list still names them until
// its owner removes them under Access.
export type LeaveOutcome =
    // The sandbox's own list no longer holds this person, or never did (a 403 is "already removed"), or it was never given
    // an address that could hold one.
    | { readonly grant: `dropped` }
    // Left on the account, but the sandbox could not be asked, so it still lists this person.
    | { readonly grant: `kept`; readonly reason: string };

// Only a member leaves: an owner removes the sandbox from the account, a different act with its own door.
export const leaveSandbox = async (sandbox: SandboxSummary): Promise<LeaveOutcome> => {
    let outcome: LeaveOutcome = { grant: `dropped` };
    try {
        // Taken here, not at import: the session module and the sandbox list import one another, and the first to load
        // would read the other's exports before they exist.
        await useSandboxSession().retireSandboxAccess(sandbox);
    } catch (caught) {
        outcome = { grant: `kept`, reason: messageOr(caught, t(`sandbox.leaveSandbox.unreachable`)) };
    }
    await apiClient.sandbox.leave({ sandboxId: sandbox.id });
    return outcome;
};
