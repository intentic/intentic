import { skillsContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";
import { parseSkillFile } from "./skill-file.js";
import { readSkillText, skillInventory } from "./skill-inventory.js";
import { isBakedSkill, ownSkillOn, readOwnSkill, removeOwnSkill, switchOwnSkill, writeOwnSkill } from "./skills.js";

// One read over everything the agent knows, write access to the half the owner authored. An own skill's stored text
// and its loaded copy move together here and nowhere else; the settings `skills` list is the baked tools' door.
export const createSkillsRoutes = (services: Services) => {
    const i = implement(skillsContract).$context<OrpcContext>();

    return {
        list: i.list.handler(() => skillInventory(services)),
        read: i.read.handler(async ({ input }) => {
            const found = await readSkillText(services, input.id);
            if (found === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "no skill with that id, it may have been removed since this list was drawn" });
            }
            return { id: input.id, name: found.name, body: parseSkillFile(found.text).body };
        }),
        save: i.save.handler(async ({ input }) => {
            // Refused, not shadowed: both stores write the same file, so the name would silently claim the tool's
            // switch.
            if (isBakedSkill(input.name)) {
                throw new ORPCError("CONFLICT", { message: `"${input.name}" is the name of a built-in skill, choose another` });
            }
            // Read before the write: a new skill switches on; re-saving one that is off leaves it off.
            const on = (await readOwnSkill(services, input.name)) === undefined || (await ownSkillOn(services, input.name));
            await writeOwnSkill(services, input);
            if (on) {
                await switchOwnSkill(services, input, true);
            }
            return { ok: true } as const;
        }),
        switch: i.switch.handler(async ({ input }) => {
            // Only a stored skill has a switch here; a baked tool's is the settings list, and nothing else has one.
            const skill = await readOwnSkill(services, input.name);
            if (skill === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "no skill of your own with that name; a built-in tool is switched in the agent settings instead" });
            }
            await switchOwnSkill(services, skill, input.on);
            return { ok: true } as const;
        }),
        remove: i.remove.handler(async ({ input }) => {
            // Removability is the list's own answer: only an own skill and a loose file have nothing else backing them;
            // anything else would just be rewritten on the next reconcile. Matching on id is exact, since both origins
            // use the bare name as their id.
            const row = (await skillInventory(services)).find((skill) => skill.id === input.name);
            if (row?.removable !== true) {
                throw new ORPCError("BAD_REQUEST", { message: "that skill belongs to something else, remove what provides it, or switch it off" });
            }
            await removeOwnSkill(services, input.name);
            return { ok: true } as const;
        }),
    };
};
