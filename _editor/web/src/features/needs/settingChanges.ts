import type { CapabilityCatalogEntry } from "@intentic/capability-catalog";
import type { CapabilitySummary } from "@intentic/sandbox-contract/schemas/capabilities";
import { t } from "@intentic/ui/i18n";

// A change to a connection's settings in the words its form uses: the setting's label, and a value by its option's
// label ("Allowed", not `on`) wherever the field offers a choice or is a switch, so a card reads like the page the
// change lands on.

export interface SettingChange {
    readonly key: string;
    readonly label: string;
    // What it was, while that is still known: an open card reads it off the connection, a closed one no longer can.
    readonly from?: string | undefined;
    readonly to: string;
    // A free value (a host, a path) rather than one of the field's own options: set in mono.
    readonly raw: boolean;
}

type Field = CapabilityCatalogEntry[`fields`][number];

// A switch carries "on"/"off" and draws no words of its own, so a card says what the switch means for the connection.
const switchWords = (value: string): string | undefined =>
    value === `on` ? t(`needs.card.switchOn`) : value === `off` ? t(`needs.card.switchOff`) : undefined;

const valueWords = (field: Field | undefined, value: string): string =>
    (field?.boolean === true ? switchWords(value) : field?.options?.find((option) => option.value === value)?.label) ?? value;

export const settingChanges = (
    fields: readonly Field[],
    changes: Readonly<Record<string, string>> | undefined,
    current?: CapabilitySummary[`config`] | undefined,
): readonly SettingChange[] =>
    Object.entries(changes ?? {}).map(([key, to]) => {
        const field = fields.find((candidate) => candidate.key === key);
        const was = current?.[key];
        return {
            key,
            label: field?.label ?? key,
            from: was === undefined ? undefined : valueWords(field, String(was)),
            to: valueWords(field, to),
            raw: field?.options === undefined && field?.boolean !== true,
        };
    });
