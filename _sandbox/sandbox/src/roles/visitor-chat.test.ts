import { VISITOR_CHAT_ROLE } from "@intentic/sandbox-contract/schemas/roles";
import type { AccessProfile } from "@intentic/sandbox-contract/schemas/access-profiles";
import { memoryRolesStore } from "../harness/route-stores.testing.js";
import { ensureVisitorChatRole } from "./visitor-chat.js";

const memoryProfiles = (seed: AccessProfile[] = []) => {
    const kept = [...seed];
    return {
        list: async () => [...kept],
        upsert: async (profile: AccessProfile) => {
            const at = kept.findIndex((entry) => entry.id === profile.id);
            if (at === -1) {
                kept.push(profile);
            } else {
                kept[at] = profile;
            }
        },
    };
};

/* The role follows the need. */
test("writes the visitor chat and the profile that holds it into a workspace that has neither", async () => {
    const roles = memoryRolesStore();
    const profiles = memoryProfiles();
    await ensureVisitorChatRole(roles, profiles);
    expect((await roles.get(VISITOR_CHAT_ROLE))?.capabilities).toEqual([]);
    // Read-only and spending nothing: the two properties a stranger-driven wake depends on.
    const [held] = await profiles.list();
    expect(held?.roles).toEqual([VISITOR_CHAT_ROLE]);
    expect(held?.tools).toMatchObject({ files: "read", shell: false, web: false, delegate: false });
    expect(held?.credentials).toEqual({ capabilities: [], secrets: [] });
});

/* THE OWNER'S EDITS SURVIVE. */
test("leaves a visitor chat the owner has widened alone", async () => {
    const roles = memoryRolesStore([{ id: VISITOR_CHAT_ROLE, label: "Visitor chat", capabilities: ["reddit-work"] }]);
    const profiles = memoryProfiles([{ id: "public", tools: { files: "read", web: true }, roles: [VISITOR_CHAT_ROLE] }]);
    await ensureVisitorChatRole(roles, profiles);
    expect(await roles.get(VISITOR_CHAT_ROLE)).toMatchObject({ capabilities: ["reddit-work"] });
    // And no second copy of either.
    expect(await roles.list()).toHaveLength(1);
    expect(await profiles.list()).toEqual([{ id: "public", tools: { files: "read", web: true }, roles: [VISITOR_CHAT_ROLE] }]);
});

test("a profile the owner took the id of is left alone, and the card gets one of its own beside it", async () => {
    const roles = memoryRolesStore();
    const profiles = memoryProfiles([{ id: VISITOR_CHAT_ROLE, label: "Mine" }]);
    await ensureVisitorChatRole(roles, profiles);
    expect((await profiles.list()).map((profile) => profile.id)).toEqual([VISITOR_CHAT_ROLE, `${VISITOR_CHAT_ROLE}-2`]);
});
