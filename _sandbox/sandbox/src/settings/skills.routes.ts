import { skillsContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";
import { parseSkillFile } from "./skill-file.js";
import { readSkillText, skillInventory } from "./skill-inventory.js";
import { isBakedSkill, readOwnSkill, reconcileSkills, removeOwnSkill, writeOwnSkill } from "./skills.js";

// One read over everything the agent knows, write access to the half the owner authored. `save` and `remove` each write
// the text, the enabled list, and the loaded folder together, deliberately, so the screen and the next turn never
// disagree.
export const createSkillsRoutes = (services: Services) => {
    const i = implement(skillsContract).$context<OrpcContext>();

    // Sets the enabled list and reconciles the loaded folder together, the same pair the settings route performs, so
    // both doors leave disk in the same state.
    const setEnabled = async (names: readonly string[]): Promise<void> => {
        const settings = await services.sandboxSettings.get();
        await services.sandboxSettings.set({ ...settings, skills: [...names] });
        await reconcileSkills(services, names);
    };

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
            // Read before the write: a new skill switches on; re-saving one already off leaves it off.
            const isNew = (await readOwnSkill(services, input.name)) === undefined;
            await writeOwnSkill(services, input);
            const { skills } = await services.sandboxSettings.get();
            await setEnabled(isNew && !skills.includes(input.name) ? [...skills, input.name] : skills);
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
            const { skills } = await services.sandboxSettings.get();
            await setEnabled(skills.filter((name) => name !== input.name));
            return { ok: true } as const;
        }),
    };
};
