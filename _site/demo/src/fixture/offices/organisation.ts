import type { OrgDetail, OrgList } from "@intentic/api-contract";

// Fictional policy console: its read routes stay entirely inside the demo transport.
export const officeOrganisation: OrgDetail = {
    id: `transport-office`,
    name: `Transport office demo`,
    role: `admin`,
    policyVersion: 2,
    policy: { sections: { secrets: `hidden`, access: `locked` }, preset: [`privacy`, `audit`, `actions`], membersOnly: true },
    members: [{ email: `admin@example.test`, role: `admin`, addedAt: `2026-10-15T09:00:00.000Z` }],
    sandboxes: [{
        id: `office-team`, name: `Transport office team`, ownerEmail: `admin@example.test`,
        policyApplied: 2, policyResetAt: `2026-10-15T09:00:00.000Z`,
    }],
};

export const officeOrganisations: OrgList = {
    orgs: [{ id: officeOrganisation.id, name: officeOrganisation.name, role: `admin`, sandboxCount: 1 }],
    canCreate: true,
};
