import { skillsContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { parseSkillFile } from "./skill-file.js";
import { readSkillText, skillInventory } from "./skill-inventory.js";
import { isBakedSkill, readOwnSkill, reconcileSkills, removeOwnSkill, writeOwnSkill } from "./skills.js";

/* THE SKILLS SURFACE'S ROUTES, one read over everything the agent knows, and write access to the half of it the
 * owner authored.
 *
 * `save` and `remove` each do three things in one call, write the text, set the enabled list, reconcile the
 * loaded folder, and that is deliberate rather than convenient. Sequencing them from the browser would mean two
 * writes to two different stores with a window between them where the skill exists and is off, or is on and has no
 * text; the reconcile is what makes the next turn agree with the screen, and it cannot be the caller's job to
 * remember to ask for it. */
export const createSkillsRoutes = (services: Services) => {
    const i = implement(skillsContract).$context<OrpcContext>();

    // Save the settings `skills` list and converge the loaded folder against it, the same pair the settings route
    // performs, so both doors onto the enabled set leave disk in the same state.
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
            /* A baked tool's name is refused rather than shadowed. Both stores write into the same loaded folder,
             * so a skill called `lsp` would be whichever of the two the reconciler happened to write last, and
             * the owner's copy would silently claim the switch that belongs to the tool. */
            if (isBakedSkill(input.name)) {
                throw new ORPCError("CONFLICT", { message: `"${input.name}" is the name of a built-in skill, choose another` });
            }
            /* Asked BEFORE the write, because the answer stops being available the moment it lands: a skill the
             * owner is meeting for the first time is switched on (you wrote it to use it), while re-saving one
             * that is currently off leaves it off, they turned it off on purpose, and an edit is not a request to
             * turn it back on. */
            const isNew = (await readOwnSkill(services, input.name)) === undefined;
            await writeOwnSkill(services, input);
            const { skills } = await services.sandboxSettings.get();
            await setEnabled(isNew && !skills.includes(input.name) ? [...skills, input.name] : skills);
            return { ok: true } as const;
        }),
        remove: i.remove.handler(async ({ input }) => {
            /* WHETHER THIS IS REMOVABLE IS THE LIST'S OWN ANSWER, asked again here rather than re-derived. Only two
             * origins have nothing else to answer to: a skill the owner stored, and a loose file in the loaded
             * folder. Everything else is written by something, a baked tool, a connection, an extension, a plugin
             *, that would put it straight back, so deleting it would look like it worked until the next reconcile.
             *
             * Both of those origins carry the bare name as their id, so matching on id is exact: it cannot be
             * satisfied by a plugin that happens to ship a skill of the same name. */
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
