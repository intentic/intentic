import { STATE_DIR } from "@intentic/constants";
import { personaKit, readPersonaSkill, removePersona, removePersonaSkill, savePersona, savePersonaPrompt, savePersonaSkill, demoPersonas } from "./personas";
import { pushWorkspaceChanged } from "../broadcast";
import { type Doors, okAfter } from "../doors";

// The persona picker's data; three personas make the point without turning the column into a directory. Every write is
// real (daemon/personas.ts is the store), and pushed as the daemon's file watch pushes it, so the Personas page, the
// picker and any open kit re-read what changed.
const CARDS = `${STATE_DIR}/config/personas.json`;
const kitPath = (id: string): string => `${STATE_DIR}/config/personas/${id}/`;

export const personasDoors = {
    list: () => ({ personas: demoPersonas, connected: [`gmail-support`, `intercom`, `x-brand`, `linkedin`, `github`, `stripe-ops`] }),
    save: (card) =>
        okAfter(() => {
            savePersona(card);
            pushWorkspaceChanged(CARDS);
        }),
    remove: ({ id }) =>
        okAfter(() => {
            removePersona(id);
            pushWorkspaceChanged(CARDS, kitPath(id));
        }),
    kit: ({ id }) => personaKit(id),
    savePrompt: ({ id, prompt }) =>
        okAfter(() => {
            savePersonaPrompt(id, prompt);
            pushWorkspaceChanged(kitPath(id));
        }),
    readSkill: ({ id, name }) => readPersonaSkill(id, name),
    saveSkill: ({ id, name, description, body }) =>
        okAfter(() => {
            savePersonaSkill(id, name, description, body);
            pushWorkspaceChanged(kitPath(id));
        }),
    removeSkill: ({ id, name }) =>
        okAfter(() => {
            removePersonaSkill(id, name);
            pushWorkspaceChanged(kitPath(id));
        }),
} satisfies Doors<`personas`>;
