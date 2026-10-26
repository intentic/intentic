import { memberAccess } from "@intentic/sandbox-contract/schemas/members";
import type { InvariantCheck } from "../invariants/invariants.js";
import type { MembersStore } from "../auth/auth.js";
import type { AccessProfiles } from "../auth/principals/access-profiles-store.js";
import type { ServicesStore } from "../auth/principals/services-store.js";

// Who a turn acts for is spread over files that have to agree (docs/architecture/access.md): roster rows and services
// name access profiles, and services name stewards on the roster. All three are hand-editable on the history volume, and
// each broken link fails SHUT, a holder of a missing profile or a service whose steward left reaching nothing, which is
// the safe direction and therefore the silent one. The routes refuse every shape below; this catches the files being
// edited, or a steward removed, around them.

export interface AccessRosterDeps {
    readonly accessProfiles: AccessProfiles;
    readonly services: ServicesStore;
    // Whole, since the area checks registered beside these take the same roster and write through it.
    readonly members: MembersStore;
    readonly ownerEmail: () => Promise<string | undefined>;
}

export const owner = "access";

const lower = (email: string): string => email.toLowerCase();

export const checks = ({ accessProfiles, services, members, ownerEmail }: AccessRosterDeps): readonly InvariantCheck[] => [
    {
        name: "every-held-profile-exists",
        // Boot and sweep: the files change out of band (by hand, by a restore, by an organisation dropping a profile).
        on: ["boot", "sweep"],
        run: async ({ fail }) => {
            const [profiles, roster, held] = await Promise.all([accessProfiles.list(), members.list(), services.list()]);
            const known = new Set(profiles.map((profile) => profile.id));
            const orphans = [
                ...roster
                    .filter((member) => member.profile !== undefined && !known.has(member.profile))
                    .map((member) => `${member.email} → ${member.profile}`),
                ...held
                    .filter((service) => service.profile !== undefined && !known.has(service.profile))
                    .map((service) => `service ${service.id} → ${service.profile}`),
            ];
            if (orphans.length > 0) {
                fail(
                    `${orphans.join(", ")}: these name an access profile this sandbox no longer has; a person keeps the answers last written on their row, but a service holding one reaches nothing until it is given another`,
                );
            }
        },
    },
    {
        name: "every-steward-runs-agents",
        on: ["boot", "sweep"],
        run: async ({ fail }) => {
            const [held, roster, bound] = await Promise.all([services.list(), members.list(), ownerEmail()]);
            const stranded = held.filter((service) => {
                if (bound !== undefined && lower(bound) === lower(service.steward)) {
                    return false;
                }
                const member = roster.find((row) => lower(row.email) === lower(service.steward));
                if (member === undefined) {
                    return true;
                }
                const access = memberAccess(member);
                return !access.manage && access.agents !== "run";
            });
            if (stranded.length > 0) {
                fail(
                    `${stranded.map((service) => `${service.id} (${service.steward})`).join(", ")}: each acts for a steward who no longer runs agents here, so every automation, link and token running as it is skipped; give it a new steward on Access ▸ Programs`,
                );
            }
        },
    },
];

/** The invariant's deps off the daemon's services: the stores it reads. */
export const accessRosterOf = (services: AccessRosterDeps): AccessRosterDeps => ({
    accessProfiles: services.accessProfiles,
    services: services.services,
    members: services.members,
    ownerEmail: services.ownerEmail,
});
