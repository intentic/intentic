import type { AgentAccess, CredentialReach, EditScope } from "@intentic/sandbox-contract/schemas/members";
import type { GrantedRole } from "@intentic/sandbox-contract/schemas/shared";
import type { Member, MemberGrant } from "../auth.js";

// The row a grant writes: an area list is kept whatever the tier, and its absence is the whole workspace, so an
// omitted field can never read as an empty fence. Email sign-in is written only when on, and a grant that does not say
// keeps the previous row's.
// A roster row while it is being built, its optional fields added one at a time.
interface MemberRowDraft {
    email: string;
    role: GrantedRole;
    areas?: string[];
    agents?: AgentAccess;
    edit?: EditScope;
    lands?: true;
    emailSignIn?: boolean;
    credentials?: CredentialReach;
    aiAccounts?: string[];
}

// The reach a grant leaves on the row: `all` lifts it, a list replaces it, silence keeps the previous row's. A
// maintainer holds none, whatever the grant or the row before it said: the tier reads every credential, so a reach kept
// on it would read as a limit nothing enforces, and would come back the day the person is graded down.
const reachOfRow = (grant: MemberGrant, previous: Member | undefined): CredentialReach | undefined => {
    if (grant.role === "maintainer" || grant.credentials === "all") {
        return undefined;
    }
    const reach = grant.credentials ?? previous?.credentials;
    return reach === undefined ? undefined : { capabilities: [...reach.capabilities], secrets: [...reach.secrets] };
};

// The AI accounts a grant leaves on the row, by the same rule as the reach above: `all` lifts it, a list replaces it,
// silence keeps the previous row's, and a maintainer holds none, since the tier runs on every account.
const aiAccountsOfRow = (grant: MemberGrant, previous: Member | undefined): string[] | undefined => {
    if (grant.role === "maintainer" || grant.aiAccounts === "all") {
        return undefined;
    }
    const kept = grant.aiAccounts ?? previous?.aiAccounts;
    return kept === undefined ? undefined : [...new Set(kept)];
};

export const memberRow = (email: string, grant: MemberGrant, previous?: Member): Member => {
    const row: MemberRowDraft = { email, role: grant.role };
    if (grant.areas !== undefined) {
        row.areas = [...grant.areas];
    }
    // Written as the grant said them, and never on a maintainer, whose tier already answers both.
    if (grant.agents !== undefined && grant.role !== "maintainer") {
        row.agents = grant.agents;
    }
    if (grant.edit !== undefined && grant.role !== "maintainer") {
        row.edit = grant.edit === "all" ? "all" : [...grant.edit];
    }
    // Written only when on, and only where it means something: a grant that does not say takes it back.
    if (grant.lands === true && grant.agents === "home") {
        row.lands = true;
    }
    if (grant.emailSignIn ?? previous?.emailSignIn === true) {
        row.emailSignIn = true;
    }
    const credentials = reachOfRow(grant, previous);
    if (credentials !== undefined) {
        row.credentials = credentials;
    }
    const aiAccounts = aiAccountsOfRow(grant, previous);
    if (aiAccounts !== undefined) {
        row.aiAccounts = aiAccounts;
    }
    return row;
};
