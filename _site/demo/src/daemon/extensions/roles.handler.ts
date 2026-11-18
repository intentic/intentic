import { STATE_DIR } from "@intentic/constants";
import { roleKit, readRoleSkill, removeRole, removeRoleSkill, saveRole, saveRolePrompt, saveRoleSkill, demoRoles } from "./roles";
import { pushWorkspaceChanged } from "../broadcast";
import { type Doors, okAfter } from "../doors";

// The role picker's data; three roles make the point without turning the column into a directory. Every write is
// real (daemon/roles.ts is the store), and pushed as the daemon's file watch pushes it, so the Roles page, the
// picker and any open kit re-read what changed.
const CARDS = `${STATE_DIR}/config/roles.json`;
const kitPath = (id: string): string => `${STATE_DIR}/config/roles/${id}/`;

export const rolesDoors = {
    list: () => ({ roles: demoRoles, connected: [`gmail-support`, `intercom`, `x-brand`, `linkedin`, `github`, `stripe-ops`] }),
    save: (card) =>
        okAfter(() => {
            saveRole(card);
            pushWorkspaceChanged(CARDS);
        }),
    remove: ({ id }) =>
        okAfter(() => {
            removeRole(id);
            pushWorkspaceChanged(CARDS, kitPath(id));
        }),
    kit: ({ id }) => roleKit(id),
    savePrompt: ({ id, prompt }) =>
        okAfter(() => {
            saveRolePrompt(id, prompt);
            pushWorkspaceChanged(kitPath(id));
        }),
    readSkill: ({ id, name }) => readRoleSkill(id, name),
    saveSkill: ({ id, name, description, body }) =>
        okAfter(() => {
            saveRoleSkill(id, name, description, body);
            pushWorkspaceChanged(kitPath(id));
        }),
    removeSkill: ({ id, name }) =>
        okAfter(() => {
            removeRoleSkill(id, name);
            pushWorkspaceChanged(kitPath(id));
        }),
} satisfies Doors<`roles`>;
