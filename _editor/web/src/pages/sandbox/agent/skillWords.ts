import type { SkillOrigin, SkillSummary } from "@intentic-app/api-contract";

/* WHERE A SKILL CAME FROM, IN WORDS — the one vocabulary the Skills list draws its chips from. What each origin
 * LOOKS like is skillVisual.ts's business, so a mark and a word can never be argued about in two files.
 *
 * The whole value of the list is this column. A skill costs the agent attention on every turn whether or not
 * anyone remembers adding it, so "what is my agent carrying, and which of it did I choose" is the question the
 * surface exists to answer — and it is answerable only if each origin reads as a different KIND of thing rather
 * than as a different word for "installed".
 *
 * A CHIP AND NOTHING MORE, which is a decision this made twice. Each origin also had a sentence saying where to go
 * to change it ("Ships inside a plugin you installed. Remove the plugin to drop it."), rendered on every row that
 * has no switch. On screen it was the same sentence four times down one group, it pushed most rows onto two lines,
 * and it said what the chip beside it had already said: a row reading "Plugin · team-pack" does not need a
 * paragraph to explain that the plugin owns it. What the reader genuinely cannot infer — what each kind lets them
 * DO — is one table in the group's (i), read once, instead of a line paid for on every row forever. */

const CHIPS = {
    own: `Yours`,
    // Named for the CARD rather than for the owner, because that is the fact the reader needs: this one is not
    // on for every chat, only for turns wearing that persona. The owner's name follows it, as it does for an
    // extension — "Persona · Studio".
    persona: `Persona`,
    builtin: `Built in`,
    capability: `Connection`,
    extension: `Extension`,
    plugin: `Plugin`,
    dropped: `Loose file`,
    // `satisfies` rather than an annotation: the daemon owns the origin list, and a kind added there has to be a
    // build error here rather than a row drawn with no chip.
} satisfies Record<SkillOrigin, string>;

/* The chip a row wears, assembled from what the daemon said about it. The owner's name follows the kind when there
 * is one — "Extension · knowledge" tells you which of six extensions to go and look at, and the kind alone does
 * not. This is the whole of what a row says about provenance, and it is enough. */
export const provenanceOf = (skill: SkillSummary): string => {
    const chip = CHIPS[skill.origin];
    return skill.owner === undefined ? chip : `${chip} · ${skill.owner}`;
};
