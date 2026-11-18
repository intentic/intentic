import { VISITOR_CHAT_ROLE, type Role } from "@intentic/sandbox-contract/schemas/roles";
import type { AccessProfile } from "@intentic/sandbox-contract/schemas/access-profiles";
import type { AccessProfiles } from "../auth/principals/access-profiles-store.js";
import type { RolesStore } from "./roles-store.js";

// The one role the daemon writes itself: a read-only role a public web chat answers through, created only when a
// Visitor chat is saved, never seeded at boot, with the access profile that holds it. Re-created after deletion if a
// Visitor chat still exists, since it is a bound the role must carry, not an offer to accept or refuse.

// Fixed manner of the Visitor chat product, not owner-composed wording; folded into the turn's role guidance.
export const VISITOR_CHAT_GUIDANCE =
    "You are the visitor chat: you answer people who arrive from outside. Be brief and concrete, answer only from what is in the workspace, and say plainly when something is not something you can help with here.";

const VISITOR_CHAT_CARD: Role = {
    id: VISITOR_CHAT_ROLE,
    label: "Visitor chat",
    // Empty: workspace capability ids aren't knowable here; also the safe default, since it can't post as anyone.
    capabilities: [],
    // No `systemPromptMode`: runs on the sandbox's base prompt; an owner can still add one, like any other role.
};

// What the card may reach, as an access profile listing it (docs/architecture/access.md): the smallest toolbox there is,
// read and search only, no connection and no secret, since a stranger on a website drives this prompt.
const VISITOR_CHAT_PROFILE: AccessProfile = {
    id: VISITOR_CHAT_ROLE,
    label: "Visitor chat",
    brief: "What the public web chat may reach: reading and searching the workspace, nothing else.",
    credentials: { capabilities: [], secrets: [] },
    tools: { files: "read", shell: false, code: false, web: false, browser: false, delegate: false, sandbox: false, extensions: [] },
    roles: [VISITOR_CHAT_ROLE],
};

// Writes only what is absent: repairs a missing card or a card no profile holds, without resetting an owner's widened
// role or the profile they gave it. A profile of the same id the owner pointed elsewhere is left alone too, and a new
// one is written under a free id beside it.
export const ensureVisitorChatRole = async (
    roles: RolesStore,
    profiles: { readonly list: () => Promise<readonly Pick<AccessProfile, "id" | "roles">[]>; readonly upsert: AccessProfiles["upsert"] },
): Promise<void> => {
    if ((await roles.get(VISITOR_CHAT_ROLE)) === undefined) {
        await roles.upsert(VISITOR_CHAT_CARD);
    }
    const standing = await profiles.list();
    if (standing.some((profile) => profile.roles?.includes(VISITOR_CHAT_ROLE) === true)) {
        return;
    }
    const taken = new Set(standing.map((profile) => profile.id));
    let id = VISITOR_CHAT_PROFILE.id;
    for (let n = 2; taken.has(id); n += 1) {
        id = `${VISITOR_CHAT_PROFILE.id}-${n}`;
    }
    await profiles.upsert({ ...VISITOR_CHAT_PROFILE, id });
};
