import type { Area, Persona } from "@intentic/sandbox-contract";
import { deskEdition, freshEdition } from "../mode";

// The persona picker's cards and the named areas a grant can be fenced to, each upserted by id as the daemon's store
// upserts them, so a save is in the next read.

// Where each starts is what decides who may talk to it (policy/persona-home.ts), so the three cards cover the three
// answers: one homed in each area below, and one at the root that only an unfenced person reaches.
const codePersonas: Persona[] = [
    { id: `maya-support`, label: `Maya · Customer Care`, capabilities: [`gmail-support`, `intercom`], workspace: { startIn: `web/support` } },
    { id: `owen-growth`, label: `Owen · Growth`, capabilities: [`x-brand`, `linkedin`], workspace: { startIn: `web/site` } },
    { id: `priya-ops`, label: `Priya · Operations`, capabilities: [`github`, `stripe-ops`] },
];
// The desk is one person with one assistant, so it has no team cards to pick between (fixture/openChats.ts says the
// same of its tabs): the chat's rail would otherwise open on the code workspace's support, growth and ops leads.
// A fresh sandbox has set up no team yet.
export const demoPersonas: Persona[] = deskEdition || freshEdition ? [] : codePersonas;

// Upsert by id, as the daemon's `/personas` does; the list is the store, so a saved card is in the next read.
export const savePersona = (card: Persona): void => {
    const index = demoPersonas.findIndex((persona) => persona.id === card.id);
    if (index === -1) {
        demoPersonas.push(card);
    } else {
        demoPersonas[index] = card;
    }
};

// The named parts of the workspace, upserted like the personas above: two, so a picker shows both the fence and
// what it leaves out.
export const demoAreas: Area[] = [
    { id: `support`, label: `Support desk`, brief: `Tickets, replies and the help centre.`, folders: [`web/support`] },
    { id: `site`, label: `Marketing site`, folders: [`web/site`] },
];
export const saveArea = (area: Area): void => {
    const index = demoAreas.findIndex((entry) => entry.id === area.id);
    if (index === -1) {
        demoAreas.push(area);
    } else {
        demoAreas[index] = area;
    }
};
// Refused while a demo member still holds it, as the daemon refuses one: the demo roster is the fixture's own.
export const removeArea = (id: string): void => {
    const index = demoAreas.findIndex((entry) => entry.id === id);
    if (index !== -1) {
        demoAreas.splice(index, 1);
    }
};
