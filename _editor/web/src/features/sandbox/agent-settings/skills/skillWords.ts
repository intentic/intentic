import type { SkillOrigin, SkillSummary } from "@intentic/sandbox-contract";
import type { StatusVariant } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";

// Words for each skill origin; skillVisual.ts owns what it looks like. A chip is all a row says about
// provenance: what each kind lets you do lives once in the group's info, not repeated per row.

// Built when read, so a chip follows a language switch.
const chips = (): Record<SkillOrigin, string> =>
    ({
        own: t(`sandbox.skillWords.own`),
        // Named for the persona card, not the owner: it applies to that persona's turns only, not every chat.
        persona: t(`sandbox.skillWords.persona`),
        builtin: t(`sandbox.skillWords.builtin`),
        capability: t(`sandbox.skillWords.capability`),
        extension: t(`sandbox.skillWords.extension`),
        plugin: t(`sandbox.skillWords.plugin`),
        dropped: t(`sandbox.skillWords.dropped`),
        // `satisfies`, so a new origin in the daemon's enum is a build error here rather than a chip-less row.
    }) satisfies Record<SkillOrigin, string>;

const VARIANTS = {
    own: `primary`,
    persona: `neutral`,
    builtin: `neutral`,
    capability: `info`,
    extension: `info`,
    plugin: `info`,
    dropped: `neutral`,
} satisfies Record<SkillOrigin, StatusVariant>;

// The chip a row wears; owner follows the kind when there is one ("Extension · knowledge") so you know which one.
export const provenanceOf = (skill: SkillSummary): string => {
    const chip = chips()[skill.origin];
    return skill.owner === undefined ? chip : `${chip} · ${skill.owner}`;
};

export const provenanceVariant = (skill: SkillSummary): StatusVariant => VARIANTS[skill.origin];
