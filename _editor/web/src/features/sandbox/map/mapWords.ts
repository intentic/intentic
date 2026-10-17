import type { ControlScope } from "@intentic/sandbox-contract/policy/control-scopes";
import type { MemberRole } from "@intentic/sandbox-contract/schemas/shared";
import type { IconName } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import { type GroupKey, type MapNode, type Principal, REST_ID } from "./reachModel";

// The map's words and marks for the model's ids: the model stays language-free, and every surface of the map (the stage,
// the caption) names a thing through here, so the two cannot call one node two names.

export const GROUP_ICONS = {
    services: `bolt`,
    accounts: `globe`,
    machines: `desktop`,
    sandboxes: `link`,
    network: `wifi`,
    models: `sparkles`,
} as const satisfies Record<GroupKey, IconName>;

export const groupLabel = (key: GroupKey): string =>
    ({
        services: t(`sandbox.sandboxMap.groupServices`),
        accounts: t(`sandbox.sandboxMap.groupAccounts`),
        machines: t(`sandbox.sandboxMap.groupMachines`),
        sandboxes: t(`sandbox.sandboxMap.groupSandboxes`),
        network: t(`sandbox.sandboxMap.groupNetwork`),
        models: t(`sandbox.sandboxMap.groupModels`),
    })[key];

/** A node's name on screen; the model keeps an id where only the view has the words. */
export const nodeLabel = (node: MapNode, areasExist: boolean): string => {
    switch (node.kind) {
        case `rest`:
            return areasExist ? t(`sandbox.sandboxMap.restOfWorkspace`) : t(`sandbox.sandboxMap.wholeWorkspace`);
        case `session`:
            return t(`sandbox.sandboxMap.signedOutBrowser`);
        case `outbox`:
            return t(`sandbox.sandboxMap.outbox`);
        case `port`:
            return t(`sandbox.sandboxMap.port`, { port: node.label });
        default:
            return node.label;
    }
};

export const nodeDetail = (node: MapNode): string | undefined => {
    if (node.kind === `outbox`) {
        const count = Number(node.detail ?? 0);
        return t(`sandbox.sandboxMap.outboxFiles`, { count }, count);
    }
    return node.detail === `` ? undefined : node.detail;
};

// Spelled as calls rather than a table of keys, so the catalog check sees every word the map uses.
const ROLE_WORDS = {
    owner: () => t(`sandbox.sandboxMap.roleOwner`),
    maintainer: () => t(`sandbox.sandboxMap.roleMaintainer`),
    writer: () => t(`sandbox.sandboxMap.roleWriter`),
    collaborator: () => t(`sandbox.sandboxMap.roleCollaborator`),
    guest: () => t(`sandbox.sandboxMap.roleGuest`),
    viewer: () => t(`sandbox.sandboxMap.roleViewer`),
} as const satisfies Record<MemberRole, () => string>;

const SCOPE_WORDS = {
    read: () => t(`sandbox.sandboxMap.scopeRead`),
    drive: () => t(`sandbox.sandboxMap.scopeDrive`),
    land: () => t(`sandbox.sandboxMap.scopeLand`),
    editor: () => t(`sandbox.sandboxMap.scopeEditor`),
} as const satisfies Record<ControlScope, () => string>;

const INERT_WORDS = {
    expired: () => t(`sandbox.sandboxMap.inertExpired`),
    minter: () => t(`sandbox.sandboxMap.inertMinter`),
    persona: () => t(`sandbox.sandboxMap.inertPersona`),
    invite: () => t(`sandbox.sandboxMap.inertInvite`),
} as const;

/** The persona a link's tasks wear, by its name on the card. */
export type PersonaName = (id: string) => string;

/** The one line under a principal's name: what it may do, or why it holds nothing. */
export const principalLine = (principal: Principal, personaName: PersonaName): string => {
    if (principal.inert !== undefined) {
        return INERT_WORDS[principal.inert]();
    }
    if (principal.kind === `token`) {
        return SCOPE_WORDS[principal.scope ?? `read`]();
    }
    if (principal.kind === `link`) {
        return principal.actsAs === undefined ? t(`sandbox.sandboxMap.noPersona`) : t(`sandbox.sandboxMap.asPersona`, { persona: personaName(principal.actsAs) });
    }
    const role = ROLE_WORDS[principal.role ?? `viewer`]();
    return principal.status === `invited` ? t(`sandbox.sandboxMap.invitedLine`, { role }) : role;
};

/** A principal's name: the part of an address before the `@` reads as the person; a token or link by its label. */
export const principalName = (principal: Principal): string => {
    if (principal.kind !== `person`) {
        return principal.label;
    }
    const at = principal.label.lastIndexOf(`@`);
    return at <= 0 ? principal.label : principal.label.slice(0, at);
};

/** Where a node is changed, for the caption's one action; undefined where nothing on the map's side edits it. */
export const editPath = (node: MapNode): string | undefined => {
    switch (node.kind) {
        case `area`:
        case `rest`:
            return `/sandbox/areas`;
        case `persona`:
            return node.ref === undefined ? `/sandbox/personas` : `/sandbox/personas?open=${encodeURIComponent(node.ref)}`;
        case `secret`:
            return `/sandbox/secrets`;
        case `model`:
            return `/sandbox/models`;
        case `capability`:
            return node.capabilityKind === `device` || node.capabilityKind === `phone` ? `/devices` : `/capabilities`;
        default:
            return undefined;
    }
};

export const editWords = (node: MapNode): string => {
    switch (node.kind) {
        case `area`:
        case `rest`:
            return t(`sandbox.sandboxMap.editAreas`);
        case `persona`:
            return t(`sandbox.sandboxMap.editPersona`);
        case `secret`:
            return t(`sandbox.sandboxMap.openSecrets`);
        case `model`:
            return t(`sandbox.sandboxMap.openModels`);
        default:
            return t(`sandbox.sandboxMap.openConnection`);
    }
};

/** Whether a node id names the workspace's own ground (an area, or the rest of it). */
export const isGround = (id: string): boolean => id === REST_ID || id.startsWith(`area:`);
