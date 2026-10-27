import { automationApprovals, automationCatalog, automationsList, checkDemoSource, deleteAutomation, resolveApproval, saveAutomation } from "../../fixture/automations";
import { approveWake, rotateAutomationToken, runAutomation, sendersOf, setAutomationEnabled } from "./wakes";
import { type Doors, okAfter } from "../doors";

// The fixture is the store: saving, switching, deleting and clearing a held wake change the next read, and firing one
// (or approving a held fire) starts a conversation on the board whose run lands in the history when it ends
// (daemon/wakes.ts).
export const automationsDoors = {
    list: () => ({ automations: automationsList(Date.now()) }),
    // What can wake an agent and what it can start from, for the composer's source picker.
    catalog: () => automationCatalog(),
    // A source's check, answered from the fixture: the demo reaches no registry, GitHub or page.
    check: ({ source }) => checkDemoSource(source),
    pendingList: () => ({ approvals: automationApprovals(Date.now()), unreadable: [] }),
    upsert: (automation) => okAfter(() => saveAutomation(Date.now(), automation)),
    setEnabled: ({ id, enabled }) => okAfter(() => setAutomationEnabled(id, enabled)),
    remove: ({ id }) => okAfter(() => deleteAutomation(Date.now(), id)),
    rotateToken: ({ id }) => rotateAutomationToken(id),
    run: ({ id }) => okAfter(() => runAutomation(id)),
    senders: ({ provider }) => ({ senders: sendersOf(provider, Date.now()) }),
    approve: ({ id }) => okAfter(() => approveWake(id)),
    reject: ({ id }) => okAfter(() => resolveApproval(Date.now(), id)),
} satisfies Doors<`automations`>;
