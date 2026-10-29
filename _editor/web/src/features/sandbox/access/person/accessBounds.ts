import { MANAGE_RIGHTS, type ManageRight, type Member, peopleChangeRefusal } from "@intentic/sandbox-contract/schemas/members";
import type { GrantedRole, MemberRole } from "@intentic/sandbox-contract/schemas/shared";

// WHAT THE PERSON EDITING THE ROSTER MAY CHANGE OF ONE PERSON'S ACCESS, asked of the contract's own bound
// (`peopleChangeRefusal`) so the panel offers exactly what the daemon and the platform will take. The owner and Full
// access change anyone's, their own included. Someone given People & access changes anyone's below Full access but
// their own, never grants Full access, and hands out only the rights they hold. Pure, so each answer is tested here.

/** Who is editing, as the bound reads them: their address, their tier, and the rights their own row names. */
export interface PeopleManager {
    readonly email: string;
    readonly role: MemberRole;
    readonly manages?: readonly ManageRight[] | undefined;
}

/** Why a person's panel is read-only for this manager: it is their own access, or a Full access person's. */
export type PanelLock = `own` | `full`;

export interface PanelBounds {
    /** Undefined when they may change this person's access. */
    readonly locked: PanelLock | undefined;
    /** Whether Full access may be chosen for this person. */
    readonly full: boolean;
    /** The rights this manager may switch on or off for this person. */
    readonly rights: ReadonlySet<ManageRight>;
}

/** What the owner and Full access may change: everything. */
export const OPEN_BOUNDS: PanelBounds = { locked: undefined, full: true, rights: new Set(MANAGE_RIGHTS) };

/** The access the person holds as the bound reads it: the daemon's row, else the platform's tier for one it never wrote. */
const heldOf = (row: Pick<Member, `role` | `manages`> | undefined, recorded: GrantedRole) => row ?? { role: recorded };

export const panelBounds = (
    manager: PeopleManager,
    email: string,
    row: Pick<Member, `role` | `manages`> | undefined,
    recorded: GrantedRole,
): PanelBounds => {
    const before = heldOf(row, recorded);
    // Taking access away is refused exactly where changing it at all is: their own, and a Full access person's.
    const removal = peopleChangeRefusal(manager, { email, before });
    const locked = removal === undefined ? undefined : manager.email.toLowerCase() === email.toLowerCase() ? `own` : `full`;
    // A right is theirs to hand out when granting it to someone who has none would be taken.
    const fresh = { role: before.role, manages: [] };
    const rights = new Set(
        MANAGE_RIGHTS.filter((right) => locked === undefined && peopleChangeRefusal(manager, { email, before: fresh, after: { role: before.role, manages: [right] } }) === undefined),
    );
    return {
        locked,
        full: locked === undefined && peopleChangeRefusal(manager, { email, before, after: { role: `maintainer` } }) === undefined,
        rights,
    };
};
