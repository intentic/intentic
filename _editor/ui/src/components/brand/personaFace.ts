/* What <PersonaFace> needs of a persona, and nothing more, so a folder card, a rail row, a picker option and
 * the page's own list all satisfy it without any of them having to hold a whole Persona to draw one.
 *
 * IT LIVES IN ITS OWN MODULE RATHER THAN IN THE COMPONENT because `picker.ts` names this type, and picker.ts is
 * imported by node-environment tests that must not boot a `.vue` graph (see the barrel's note about
 * Picker.vue wanting a DOM). A type in a plain module costs nothing to import from anywhere. */
export interface PersonaLike {
    readonly id: string;
    readonly label?: string;
}
