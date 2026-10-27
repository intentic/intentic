import type { Area } from "@intentic/sandbox-contract/schemas/areas";
import { isBuiltInPersona, type Persona, type PersonaKit } from "@intentic/sandbox-contract/schemas/personas";
import type { SandboxHandlerOutput } from "@intentic/sandbox-contract/protocol/procedure-types";
import { refuse } from "@intentic/contract-serve";
import { automationsList } from "../../fixture/automations";
import { deskEdition, freshEdition } from "../../mode";

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

// Each persona's kit, as `.intentic/config/personas/<id>/` holds it: what it is told on top of the sandbox's own
// prompt, and the skills only its conversations reach. Maya's is filled in, since a support lead is the card whose
// instructions matter most; the others start empty, which is what a card nobody has written for yet looks like.
interface Kit {
    prompt: string;
    readonly skills: Map<string, { description: string; body: string }>;
}

const MAYA_PROMPT = `You answer acme's customers as Maya, the support lead. Be warm and brief, sign off with "Maya, acme support".

- Look the order up before you answer: never guess a delivery date.
- Refunds over 200 USD go to Priya before you promise anything.
- Never paste a tracking link from a carrier you have not checked yourself.`;

const seededKits = (): Map<string, Kit> =>
    new Map(
        demoPersonas.map((persona) => [
            persona.id,
            persona.id === `maya-support`
                ? {
                      prompt: MAYA_PROMPT,
                      skills: new Map([
                          [
                              `refund-macro`,
                              {
                                  description: `Use when a customer asks for a refund for a damaged or missing parcel.`,
                                  body: `# Refund macro\n\n1. Find the order in Stripe by the customer's email.\n2. Damaged: ask for one photo, then refund in full.\n3. Missing: check the carrier's last scan; past 7 days, refund or reship, the customer's choice.\n\nOver 200 USD: hand it to Priya with the order id and stop.`,
                              },
                          ],
                          [
                              `shipping-delays`,
                              { description: `Use when a customer asks where their parcel is.`, body: `# Where is my parcel\n\nRead the carrier's last scan, quote it, and give the next step with a date. Never promise a day the carrier has not.` },
                          ],
                      ]),
                  }
                : { prompt: ``, skills: new Map() },
        ]),
    );

let kits: Map<string, Kit> | undefined;
const kitsNow = (): Map<string, Kit> => (kits ??= seededKits());

// A kit write needs its persona: a missing one is refused rather than created by side effect, as the daemon refuses it.
const kitOf = (id: string): Kit => {
    if (!demoPersonas.some((persona) => persona.id === id)) {
        return refuse(`no persona with that id, it may have been removed since this page was drawn`, 404);
    }
    const found = kitsNow().get(id) ?? { prompt: ``, skills: new Map() };
    kitsNow().set(id, found);
    return found;
};

export const personaKit = (id: string): PersonaKit => {
    const kit = kitsNow().get(id);
    return { prompt: kit?.prompt ?? ``, skills: [...(kit?.skills.entries() ?? [])].map(([name, skill]) => ({ name, description: skill.description })) };
};

// An empty prompt removes the file, so the persona falls back to the sandbox's own instructions.
export const savePersonaPrompt = (id: string, prompt: string): void => {
    kitOf(id).prompt = prompt.trim() === `` ? `` : prompt;
};

export const readPersonaSkill = (id: string, name: string): SandboxHandlerOutput<`personas`, `readSkill`> => {
    const skill = kitsNow().get(id)?.skills.get(name) ?? refuse(`no such skill on that persona, it may have been removed since this list was drawn`, 404);
    return { name, ...skill };
};

export const savePersonaSkill = (id: string, name: string, description: string, body: string): void => {
    kitOf(id).skills.set(name, { description, body });
};

export const removePersonaSkill = (id: string, name: string): void => {
    kitsNow().get(id)?.skills.delete(name);
};

// Refused while an automation still wears it, as the daemon refuses it: it would run with no tools and no accounts.
export const removePersona = (id: string): void => {
    if (isBuiltInPersona(id)) {
        refuse(`"${id}" is a built-in persona: it is always there and cannot be removed`, 400);
    }
    const wearing = automationsList(Date.now())
        .filter((automation) => automation.actsAs === id)
        .map((automation) => automation.id);
    if (wearing.length > 0) {
        const one = wearing.length === 1;
        refuse(
            `still worn by ${one ? `the automation` : `the automations`} ${wearing.join(`, `)}: point ${one ? `it` : `them`} at another persona first, or they would run with no tools and no accounts`,
            409,
        );
    }
    const index = demoPersonas.findIndex((persona) => persona.id === id);
    if (index !== -1) {
        demoPersonas.splice(index, 1);
    }
    kitsNow().delete(id);
};
