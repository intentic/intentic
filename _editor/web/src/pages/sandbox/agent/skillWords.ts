import type { SkillOrigin, SkillSummary } from "@intentic-app/api-contract";
import type { IconName } from "@intentic/ui";

/* WHERE A SKILL CAME FROM, IN WORDS — the one vocabulary the Skills list draws its rows and its chips from.
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

interface OriginWords {
    readonly chip: string;
    readonly icon: IconName;
}

const ORIGINS = {
    own: { chip: `Yours`, icon: `user` },
    builtin: { chip: `Built in`, icon: `box` },
    capability: { chip: `Connection`, icon: `link` },
    extension: { chip: `Extension`, icon: `sliders-h` },
    plugin: { chip: `Plugin`, icon: `clone` },
    dropped: { chip: `Loose file`, icon: `file` },
    // `satisfies` rather than an annotation: the daemon owns the origin list, and a kind added there has to be a
    // build error here rather than a row drawn with no icon and no chip.
} satisfies Record<SkillOrigin, OriginWords>;

export const originOf = (origin: SkillOrigin): OriginWords => ORIGINS[origin];

/* The chip a row wears, assembled from what the daemon said about it. The owner's name follows the kind when there
 * is one — "Extension · knowledge" tells you which of six extensions to go and look at, and the kind alone does
 * not. This is the whole of what a row says about provenance, and it is enough. */
export const provenanceOf = (skill: SkillSummary): string => {
    const { chip } = originOf(skill.origin);
    return skill.owner === undefined ? chip : `${chip} · ${skill.owner}`;
};
