import "@intentic/testing/dom";
import { ASSISTANT_ACCESSORIES, ASSISTANT_COLORS, assistantFace, personaAccessory } from "@intentic/ui";

// A persona's face is the same clay companion everywhere, told apart by a color hashed from its id and a prop read
// from its name (_editor/ui/src/components/brand/personaAccessory.ts). The prop is the one mark that says what the
// persona is for, so each rule that picks it is pinned here with the name that exercises it.

const holds = (label: string, id = label.toLowerCase().replace(/[^a-z0-9]+/g, `-`)): string => personaAccessory({ id, label });

test("a project persona still named after its repository codes, whatever the repository is called", () => {
    expect(personaAccessory({ id: `project-intentic`, label: `intentic` })).toBe(`terminal`);
    expect(personaAccessory({ id: `project-extensions-intentic-saldeo`, label: `intentic-saldeo` })).toBe(`terminal`);
    expect(personaAccessory({ id: `project-design-system`, label: `design-system` })).toBe(`terminal`);
    expect(personaAccessory({ id: `project-tools-cli-v2`, label: `cli.v2` })).toBe(`terminal`);
});

test("a renamed project persona, or a card whose own name starts with project, is read by its name", () => {
    expect(personaAccessory({ id: `project-design-system`, label: `Brand Designer` })).toBe(`palette`);
    expect(personaAccessory({ id: `project-planner`, label: `Project Planner` })).toBe(`compass`);
});

test("each specialty's own title reaches its prop", () => {
    expect(holds(`Developer`)).toBe(`terminal`);
    expect(holds(`UX Expert`)).toBe(`palette`);
    expect(holds(`UI/UX`)).toBe(`palette`);
    expect(holds(`Researcher`)).toBe(`magnifier`);
    expect(holds(`Copywriter`)).toBe(`scroll`);
    expect(holds(`Tutor`)).toBe(`book`);
    expect(holds(`Planner`)).toBe(`compass`);
    expect(holds(`Gardener`)).toBe(`sprout`);
    expect(holds(`Security`)).toBe(`shield`);
    expect(Object.keys(ASSISTANT_ACCESSORIES)).toEqual([`terminal`, `palette`, `magnifier`, `scroll`, `book`, `compass`, `sprout`, `shield`]);
});

test("the rightmost specialty wins, since a title ends in what the person does", () => {
    expect(holds(`UX Writer`)).toBe(`scroll`);
    expect(holds(`Frontend Designer`)).toBe(`palette`);
    expect(holds(`Code Reviewer`)).toBe(`magnifier`);
    expect(holds(`Design Engineer`)).toBe(`palette`);
});

test("two words read as one only when the joined word says more than the first alone", () => {
    expect(holds(`Front-end dev`)).toBe(`terminal`);
    expect(holds(`Book keeper`)).toBe(`book`);
    expect(holds(`On call`)).toBe(`shield`);
    expect(holds(`Security Researcher`)).toBe(`magnifier`);
});

test("a generic title decides only when no specialty was named", () => {
    expect(holds(`QA Engineer`)).toBe(`shield`);
    expect(holds(`Marketing Lead`)).toBe(`sprout`);
    expect(holds(`Engineer`)).toBe(`terminal`);
    expect(holds(`Product Manager`)).toBe(`compass`);
    expect(holds(`Team Lead`)).toBe(`compass`);
});

test("names are read through case, separators and accents, in Polish too", () => {
    expect(holds(`uxDesigner`)).toBe(`palette`);
    expect(holds(`SECURITY_AUDITOR`)).toBe(`shield`);
    expect(holds(`Księgowa`, `ksiegowa`)).toBe(`book`);
    expect(holds(`Tłumacz`, `tlumacz`)).toBe(`scroll`);
});

test("a name that says nothing about a job codes, and the label outranks a stale id", () => {
    expect(holds(`Ada`)).toBe(`terminal`);
    expect(holds(`saldeo`)).toBe(`terminal`);
    expect(personaAccessory({ id: `designer` })).toBe(`palette`);
    expect(personaAccessory({ id: `designer`, label: `Ada` })).toBe(`terminal`);
});

// Pinned by value: a change to the hash recolors every persona anyone has, which should be a decision, not a side effect.
test("the body color is the id's, from the palette, and the same on every call", () => {
    expect(ASSISTANT_COLORS.map((color) => color.id)).toEqual([`coral`, `amber`, `sage`, `teal`, `sky`, `periwinkle`, `orchid`, `sand`]);
    expect(assistantFace(`ux-expert`).color.id).toBe(`sand`);
    expect(assistantFace(`project-intentic`).color.id).toBe(`teal`);
    expect([`a`, `b`, `c`].map((seed) => assistantFace(seed).color.id)).toEqual([`coral`, `periwinkle`, `amber`]);
    expect(assistantFace(`ux-expert`).color).toBe(assistantFace(`ux-expert`).color);
});
