import { noteAudit } from "../audit/audit-http.js";
import { rolesContract } from "@intentic/sandbox-contract/contracts/roles.contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";
import { hasSession } from "../browser/sessions/session-store.js";
import { versionedSettingsWrite } from "../seams/config-commits/settings-versions.js";
import { stateRelPath } from "../state-paths.js";
import { assistantsOf, reachableRoles } from "./role-reach.js";
import { rolesDocument } from "./roles-store.js";
import { refuseBuiltInId, refuseUnlessRemovable } from "./role-wearers.js";
import {
    listRoleSkills,
    readRolePrompt,
    readRoleSkill,
    removeRoleKit,
    removeRolePrompt,
    removeRoleSkill,
    writeRolePrompt,
    writeRoleSkill,
} from "./role-kit.js";

// Sandbox's named roles: saving or removing a role connects or disconnects nothing, since accounts are capabilities
// with their own lifecycle. What a role owns is its kit folder, written by the routes below and removed with `remove`.
// Which role a new chat belongs to is not here: it is read with what the chat runs on, in one call (agent.routeChat).

export const createRolesRoutes = (services: Services) => {
    const i = implement(rolesContract).$context<OrpcContext>();
    const root = services.workspace.root;

    // Every kit write goes through the role first: an orphaned kit is unreachable, and its manifest needs the role's
    // label. A missing role 404s rather than being created, so this surface can't mint a role by side effect.
    const requireRole = async (id: string) => {
        const found = await services.roles.get(id);
        if (found === undefined) {
            throw new ORPCError("NOT_FOUND", { message: "no role with that id, it may have been removed since this page was drawn" });
        }
        return found;
    };

    // Every write here is the Roles page's own, so each is committed as it lands (settings-versions.ts): left
    // uncommitted, a land touching roles.json was refused as the owner's edits. Only where the paths held nothing
    // uncommitted before it: a kit folder an agent's land left changes in is not the page's to commit unreviewed.
    const kitPath = (id: string): string => stateRelPath(".intentic/config/roles/", id);
    const versioned = <T>(paths: readonly string[], subject: string, write: () => Promise<T>): Promise<T> =>
        versionedSettingsWrite(services, paths, `Settings: ${subject}`, write);

    return {
        list: i.list.handler(async ({ context }) => {
            // A fenced member is shown the roles that work in the part of the workspace they hold, and nothing about
            // the others, down to the accounts they name.
            const [roles, capabilities] = await Promise.all([
                reachableRoles(services, context.identity?.areas, assistantsOf(context.identity)),
                services.capabilities.list(),
            ]);
            const fenced = context.identity?.areas !== undefined || assistantsOf(context.identity) !== undefined;
            const reachable = fenced ? new Set(roles.flatMap((role) => role.capabilities)) : undefined;
            // `hasSession`, not manifest presence: exists before login finishes, a cloned workspace's usual state. The
            // owner's own browser is a role's account too (policy/role-capability.ts), connected while its
            // extension publishes tools here.
            const ownBrowsers = new Set(((await services.webextReach(capabilities))?.browsers ?? []).map((browser) => browser.id));
            const connected = capabilities
                .filter((capability) => (capability.kind === "browser" && hasSession(services.workspace.root, capability.id)) || ownBrowsers.has(capability.id))
                .filter((capability) => reachable === undefined || reachable.has(capability.id))
                .map((capability) => capability.id);
            return { roles, connected };
        }),
        save: i.save.handler(async ({ input }) => {
            refuseBuiltInId(input.id);
            noteAudit({ target: input.id });
            await versioned([rolesDocument.path], `role ${input.label ?? input.id}`, () => services.roles.upsert(input));
            return { ok: true as const };
        }),
        remove: i.remove.handler(async ({ input }) => {
            await refuseUnlessRemovable(services, input.id);
            const removed = await services.roles.get(input.id);
            await versioned([rolesDocument.path, kitPath(input.id)], `removed role ${removed?.label ?? input.id}`, async () => {
                await services.roles.remove(input.id);
                await removeRoleKit(root, input.id);
            });
            return { ok: true as const };
        }),
        kit: i.kit.handler(async ({ input }) => {
            const [prompt, skills] = await Promise.all([readRolePrompt(root, input.id), listRoleSkills(root, input.id)]);
            return { prompt: prompt ?? "", skills: skills.map(({ name, description }) => ({ name, description })) };
        }),
        savePrompt: i.savePrompt.handler(async ({ input }) => {
            const role = await requireRole(input.id);
            // Emptying deletes the file; storing "" would leave it on a blank custom prompt, not "not written yet".
            await versioned([kitPath(input.id)], `role ${role.label ?? role.id} prompt`, () =>
                input.prompt.trim() === "" ? removeRolePrompt(root, input.id) : writeRolePrompt(root, input.id, role.label, input.prompt),
            );
            return { ok: true as const };
        }),
        readSkill: i.readSkill.handler(async ({ input }) => {
            const skill = await readRoleSkill(root, input.id, input.name);
            if (skill === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "no such skill on that role, it may have been removed since this list was drawn" });
            }
            return skill;
        }),
        saveSkill: i.saveSkill.handler(async ({ input }) => {
            const role = await requireRole(input.id);
            await versioned([kitPath(input.id)], `role ${role.label ?? role.id} skill ${input.name}`, () =>
                writeRoleSkill(root, input.id, role.label, { name: input.name, description: input.description, body: input.body }),
            );
            return { ok: true as const };
        }),
        removeSkill: i.removeSkill.handler(async ({ input }) => {
            await versioned([kitPath(input.id)], `removed skill ${input.name} from role ${input.id}`, () => removeRoleSkill(root, input.id, input.name));
            return { ok: true as const };
        }),
    };
};
