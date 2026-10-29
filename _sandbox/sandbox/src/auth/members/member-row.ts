import type { AgentAccess, CredentialReach, EditScope, ManageRight } from "@intentic/sandbox-contract/schemas/members";
import type { GrantedRole } from "@intentic/sandbox-contract/schemas/shared";
import type { ToolCeiling } from "@intentic/sandbox-contract/schemas/tool-ceiling";
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
    tools?: ToolCeiling;
    assistants?: string[];
    profile?: string;
    manages?: ManageRight[];
}

// The reach a grant leaves on the row: `all` lifts it, a list replaces it, silence keeps the previous row's, whatever the
// tier: a maintainer's conversations may be held to some connections and secrets too (docs/architecture/access.md), and
// a re-grade that never mentions it can never widen what they spend.
const reachOfRow = (grant: MemberGrant, previous: Member | undefined): CredentialReach | undefined => {
    if (grant.credentials === "all") {
        return undefined;
    }
    const reach = grant.credentials ?? previous?.credentials;
    return reach === undefined ? undefined : { capabilities: [...reach.capabilities], secrets: [...reach.secrets] };
};

// The AI accounts a grant leaves on the row, by the same rule as the reach above: `all` lifts it, a list replaces it,
// silence keeps the previous row's, a maintainer's included, so a person may manage every setting while their turns run
// only on the accounts they were given.
const aiAccountsOfRow = (grant: MemberGrant, previous: Member | undefined): string[] | undefined => {
    if (grant.aiAccounts === "all") {
        return undefined;
    }
    const kept = grant.aiAccounts ?? previous?.aiAccounts;
    return kept === undefined ? undefined : [...new Set(kept)];
};

// The tool ceiling and the assistants a grant leaves on the row, by the same rule again: `all` lifts it, a value replaces
// it, silence keeps the previous row's, and a maintainer holds neither, since the tier holds every tool and talks to
// whoever it likes.
const toolsOfRow = (grant: MemberGrant, previous: Member | undefined): ToolCeiling | undefined => {
    if (grant.role === "maintainer" || grant.tools === "all") {
        return undefined;
    }
    const kept = grant.tools ?? previous?.tools;
    return kept === undefined ? undefined : { ...kept };
};

const assistantsOfRow = (grant: MemberGrant, previous: Member | undefined): string[] | undefined => {
    if (grant.role === "maintainer" || grant.assistants === "all") {
        return undefined;
    }
    const kept = grant.assistants ?? previous?.assistants;
    return kept === undefined ? undefined : [...new Set(kept)];
};

// The rights a grant leaves on the row, by the reach's rule: a list replaces them, silence keeps the previous row's. Never
// on a maintainer, who runs every part of the sandbox, and never on a guest, who sees none of it: rights kept from a row
// that worked another way are dropped there rather than written onto a row the store would then refuse whole.
const managesOfRow = (grant: MemberGrant, previous: Member | undefined): ManageRight[] | undefined => {
    if (grant.role === "maintainer" || grant.role === "guest") {
        return undefined;
    }
    const kept = [...new Set(grant.manages ?? previous?.manages ?? [])];
    return kept.length === 0 ? undefined : kept;
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
    const tools = toolsOfRow(grant, previous);
    if (tools !== undefined) {
        row.tools = tools;
    }
    const assistants = assistantsOfRow(grant, previous);
    if (assistants !== undefined) {
        row.assistants = assistants;
    }
    // Written as the grant said it, never kept: a grant that names no profile is answers of the row's own.
    if (grant.profile !== undefined && grant.role !== "maintainer") {
        row.profile = grant.profile;
    }
    const manages = managesOfRow(grant, previous);
    if (manages !== undefined) {
        row.manages = manages;
    }
    return row;
};
