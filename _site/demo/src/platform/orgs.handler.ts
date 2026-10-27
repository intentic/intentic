import type { OrgDetail } from "@intentic/api-contract";
import {
    addMember,
    bindSandbox,
    createOrg,
    detailOf,
    isMe,
    type OrgRefusal,
    orgFor,
    orgList,
    removeMember,
    unbindSandbox,
    writePolicy,
} from "../world/organisations";
import { type PlatformRouter, refusePlatform } from "./serve";

// THE ORGANISATIONS the demo account belongs to (world/organisations.ts, seeded from fixture/offices/organisation.ts). Every
// write answers with the organisation as it now stands, re-read, as the platform's does.

const refused = (refusal: OrgRefusal): never => refusePlatform(refusal.refused, refusal.status);

type Org = Exclude<ReturnType<typeof orgFor>, OrgRefusal>;
const found = (orgId: string, admin = false): Org => {
    const org = orgFor(orgId, admin);
    return `refused` in org ? refused(org) : org;
};

// An admin's write to one organisation, then the organisation re-read.
const asAdmin = (orgId: string, write: (org: Org) => OrgRefusal | undefined): OrgDetail => {
    const org = found(orgId, true);
    const refusal = write(org);
    return refusal === undefined ? detailOf(org) : refused(refusal);
};

export const orgAnswers = {
    list: () => orgList(),
    get: ({ orgId }) => detailOf(found(orgId)),
    create: ({ name }) => detailOf(createOrg(name)),
    setPolicy: ({ orgId, rules, expectedVersion }) => asAdmin(orgId, (org) => writePolicy(org, rules, expectedVersion)),
    addMember: ({ orgId, email, role }) => asAdmin(orgId, (org) => addMember(org, email, role)),
    // A departing admin no longer has an organisation to display: their own removal answers null.
    removeMember: ({ orgId, email }) => {
        const detail = asAdmin(orgId, (org) => removeMember(org, email));
        return isMe(email) ? null : detail;
    },
    bindSandbox: ({ orgId, sandboxId }) => asAdmin(orgId, (org) => bindSandbox(org, sandboxId)),
    unbindSandbox: ({ orgId, sandboxId }) => asAdmin(orgId, (org) => unbindSandbox(org, sandboxId)),
} satisfies NonNullable<PlatformRouter[`org`]>;
