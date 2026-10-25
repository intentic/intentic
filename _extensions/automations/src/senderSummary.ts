import type { AutomationSummary } from "@intentic/sandbox-contract/schemas/automations";
import { t } from "./i18n.js";

// Who an automation answers, as its row says it: how many people and groups its sender rules name, then what everyone
// else gets. Undefined for an automation with no rules, which answers everyone its source lets through.
type Senders = AutomationSummary[`senders`];

const othersPhrase = (others: NonNullable<Senders>[`others`]): string =>
    ({
        ignore: t(`automationRow.othersPhrase.ignore`),
        hold: t(`automationRow.othersPhrase.hold`),
        allow: t(`automationRow.othersPhrase.allow`),
    })[others];
const namedIn = (senders: NonNullable<Senders>) => ({
    people: senders.rules.reduce((sum, rule) => sum + (rule.ids?.length ?? 0), 0),
    groups: senders.rules.reduce((sum, rule) => sum + (rule.groups?.length ?? 0), 0),
});

// One phrase, for the drawer's labelled facts.
export const answersPhrase = (senders: Senders): string | undefined => {
    if (senders === undefined) {
        return undefined;
    }
    const { people, groups } = namedIn(senders);
    const named = [
        ...(people > 0 ? [t(`automationRow.peopleCount`, { count: people }, people)] : []),
        ...(groups > 0 ? [t(`automationRow.groupsCount`, { count: groups }, groups)] : []),
    ];
    return [
        named.length > 0 ? t(`automationRow.named`, { who: named.join(t(`automationRow.and`)) }) : t(`automationRow.nobodyNamed`),
        othersPhrase(senders.others),
    ].join(` · `);
};

// The same rules as a hover card on the row's glyph: the counts, then what everyone else gets.
const othersWord = (others: NonNullable<Senders>[`others`]): string =>
    others === `ignore` ? t(`automationRow.othersIgnore`) : others === `hold` ? t(`automationRow.othersHold`) : t(`automationRow.othersAllow`);
export const answersCard = (senders: Senders): { title: string; rows: { label: string; value: number | string }[] } | undefined => {
    if (senders === undefined) {
        return undefined;
    }
    const { people, groups } = namedIn(senders);
    return {
        title: t(`automationRow.answers`),
        rows: [
            { label: t(`automationRow.people`), value: people },
            { label: t(`automationRow.groups`), value: groups > 0 ? groups : `` },
            { label: t(`automationRow.others`), value: othersWord(senders.others) },
        ],
    };
};
