import type { PickerOption } from "@intentic/extension-ui";
import { FULL_ACCESS_PERSONA, isBuiltInPersona } from "@intentic/sandbox-contract/schemas/personas";
import { computed, type Ref } from "vue";
import { t } from "../i18n.js";
import type { SenderRuleDraft } from "../useAutomationForm";
import { usePersonaReach } from "./usePersonaReach";

// WHO AN AUTOMATION'S WAKES ACT AS, as the editor offers it: the two built-ins every wake can wear, then the cards, for
// the automation itself and for each sender rule. Out of AutomationFields so the form reads as its fields.

// The built-ins, ahead of the cards: Full access by its id, and No accounts as blank, which is what an unwatched wake
// naming nobody wears anyway.
const builtInOptions = (): PickerOption[] => [
    { value: FULL_ACCESS_PERSONA, label: t(`builtInPersonas.fullAccess`), description: t(`builtInPersonas.fullAccessNote`), icon: `users` as const },
    { value: ``, label: t(`builtInPersonas.noAccounts`), description: t(`builtInPersonas.noAccountsNote`), icon: `lock` as const },
];

// A pinned card since deleted keeps its face, greyed, not a glyph, so it reads as gone, not unpinned.
const goneOption = (id: string): PickerOption => ({ value: id, label: id, description: t(`automationFields.noLongerExists`), face: { id }, disabled: true });

export const usePersonaOptions = (form: { actsAs: string; senderRules: readonly SenderRuleDraft[] }, isVisitorChat: Ref<boolean>) => {
    // The cards (names only; a card's connection status is the Personas page's), and the one sentence under the picker
    // when the card it names is gone.
    const { personaList, hint: personaHint } = usePersonaReach(computed(() => (form.actsAs === `` ? {} : { actsAs: form.actsAs })));
    const cards = computed<readonly PickerOption[]>(() =>
        (personaList.data.value?.personas ?? [])
            // `face` draws the same derived character used on the Personas page and in chat, so picking who an automation
            // speaks as is the same act of recognition everywhere.
            .map((persona) => ({ value: persona.id, label: persona.label ?? persona.id, face: persona }))
            // Ordered, because a picker whose rows arrive in the file's order is a list you have to read twice.
            .toSorted((a, b) => a.label.localeCompare(b.label)),
    );
    const known = (id: string): boolean => id === `` || isBuiltInPersona(id) || cards.value.some((card) => card.value === id);

    // Blank means different things: a Visitor chat fills it in as read-only at save, elsewhere it's No accounts.
    const personaOptions = computed<readonly PickerOption[]>(() => [
        ...(isVisitorChat.value ? [{ value: ``, label: t(`automationFields.visitorChat`), description: `read-only`, icon: `globe` as const }] : builtInOptions()),
        ...cards.value,
        ...(known(form.actsAs) ? [] : [goneOption(form.actsAs)]),
    ]);

    // A rule offers the same built-ins: Full access is how the owner, writing from their own account, gets an agent that
    // may act as them.
    const rulePersonaOptions = computed<readonly PickerOption[]>(() => [
        ...builtInOptions(),
        ...cards.value,
        ...[...new Set(form.senderRules.map((rule) => rule.actsAs).filter((id) => !known(id)))].map(goneOption),
    ]);

    return { personaOptions, rulePersonaOptions, personaHint };
};
