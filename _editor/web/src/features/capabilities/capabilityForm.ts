import type { CapabilityProbe, CapabilityRecommendation, CapabilitySummary } from "@intentic/api-contract";
import { type CapabilityCatalogEntry, instancesOf } from "@intentic/capability-catalog";
import type { CapabilityField } from "@intentic/extension-manifest";
import type { ForticlientConnection } from "@intentic/sandbox-contract";
import type { NoticeModel } from "@intentic/ui";
import { computed, nextTick, reactive, type Ref, ref, watch } from "vue";
import { auditOffered, replacedPin } from "./model/audit";
import { rememberedSecrets } from "./model/devSecrets";
import { type ContributionOf, formEffects, type ManifestOf } from "./model/effects";
import {
    cleanName,
    fieldRefusal,
    fieldVerified,
    foldHoldsChoice,
    type FormValues,
    formComplete,
    forticlientAnswers,
    nameError,
    placeholderFor,
    refusedInFold,
    seedValues,
    shownFields,
    type StoredSecrets,
    submitWord,
} from "./model/form";
import { containerUrlFix, expandPaste, normalizeFieldValue, summarisesWireguard, wireguardSummary } from "./model/normalize";
import { answersSummary, hostPresets } from "./model/previews";
import { versionReadToken } from "./model/refs";
import { openingName, suggestName } from "./model/tiles";

// The configuration form over the open tile: its answers and name, which boxes were left and whether a submit was
// refused, what a paste unpacked, the Advanced fold, and what the answers add up to. Re-seeded whenever the URL opens
// another tile or connection.

export interface FormHost {
    readonly selected: Readonly<Ref<CapabilityCatalogEntry | undefined>>;
    // The connection the form is over; undefined while adding.
    readonly editing: Readonly<Ref<CapabilitySummary | undefined>>;
    // The open tile's connections, which a new name must not collide with.
    readonly instances: Readonly<Ref<readonly CapabilitySummary[]>>;
    readonly capabilities: Readonly<Ref<readonly CapabilitySummary[]>>;
    // The machine arriving to be connected, by name; `` otherwise.
    readonly device: Readonly<Ref<string>>;
    readonly recommendationFor: (tile: string) => CapabilityRecommendation | undefined;
    readonly contributionOf: ContributionOf;
    // The declaring extension's manifest, for what it does for a card beyond the card itself (its tools).
    readonly manifestOf?: ManifestOf;
    // The page's notice, which a fresh form clears.
    readonly error: Ref<NoticeModel | null>;
}

export const useCapabilityForm = ({ selected, editing, instances, capabilities, device, recommendationFor, contributionOf, manifestOf, error }: FormHost) => {
    const name = ref(``);
    // Whether the user (or a picked tile) chose the name; until then the field tracks the live suggestion.
    const nameEdited = ref(false);
    // Repaired save name (spaces/punctuation to hyphens); every consumer of the name reads this, not the raw input.
    const savedName = computed(() => cleanName(name.value));
    const namePreview = computed(() => (savedName.value !== `` && savedName.value !== name.value.trim() ? savedName.value : undefined));
    // A typed name that matches an existing connection is refused rather than silently overwritten.
    const nameCollision = computed(() => editing.value === undefined && instances.value.some((instance) => instance.id === savedName.value));
    const nameProblem = computed(() => nameError(name.value));
    const values = reactive<FormValues>({});
    // Credentials this form is keeping; cleared when the form's subject changes (e.g. a FortiClient import).
    const keptSecrets = ref<StoredSecrets>(new Set<string>());
    // Field keys the user has blurred; errors show only after a field has been visited.
    const touched = reactive(new Set<string>());
    // True once a submit has been refused; only then does an empty required field turn red.
    const attempted = ref(false);
    const shaking = ref(false);
    // One-line account of what a paste unpacked into, keyed by the field that took it.
    const pasteNotes = reactive<Record<string, string>>({});
    const advancedOpen = ref(false);
    // What the last Test said, which goes with the form it was asked of.
    const probeResult = ref<CapabilityProbe>();
    // Whose credential the last probe named; the suggestion keeps it until the form clears, so a refetch lands on `<tile>-<who>`.
    const probedWho = ref<string>();

    // A name nobody chose follows the live suggestion; editing keeps the connection's own.
    const resuggest = (entry: CapabilityCatalogEntry): void => {
        if (!nameEdited.value && editing.value === undefined) {
            name.value = suggestName(entry, instances.value, probedWho.value);
        }
    };
    watch(capabilities, () => {
        if (selected.value !== undefined) {
            resuggest(selected.value);
        }
    });

    const clear = (): void => {
        name.value = ``;
        nameEdited.value = false;
        for (const key of Object.keys(values)) {
            delete values[key];
        }
        for (const key of Object.keys(pasteNotes)) {
            delete pasteNotes[key];
        }
        probeResult.value = undefined;
        probedWho.value = undefined;
        keptSecrets.value = new Set<string>();
        error.value = null;
        touched.clear();
        attempted.value = false;
        shaking.value = false;
    };

    // Re-seeds the form whenever the URL's tile or connection changes, so a deep link to an edit works. Keyed on ids
    // rather than objects: both come from the live list, and watching objects would empty the form on every refetch.
    watch(
        // `device` rides along: arriving at a tile already open (Connect on one of its own machine rows) changes nothing else.
        [() => selected.value?.id, () => editing.value?.id, device],
        () => {
            const entry = selected.value;
            const instance = editing.value;
            if (entry === undefined) {
                return;
            }
            clear();
            const opening = openingName(entry, instance, instances.value, device.value);
            name.value = opening.name;
            nameEdited.value = opening.chosen;
            // Seed is the live config plus dev autofill; credentials aren't included (see keptSecrets).
            Object.assign(values, seedValues(entry, instance?.config, recommendationFor(entry.id)?.prefill ?? {}), rememberedSecrets(entry));
            keptSecrets.value = new Set(instance?.secrets ?? []);
            advancedOpen.value = foldHoldsChoice(entry, values);
        },
        { immediate: true },
    );

    const finishName = (): void => {
        if (namePreview.value !== undefined) {
            name.value = savedName.value;
        }
        touched.add(`name`);
    };
    // Runs on blur, when a field's value is done: trims a pasted newline, adds a scheme to a bare host, keeps only a
    // port's digits. Written back into the box so the reader sees the correction.
    const finishField = (field: CapabilityField): void => {
        values[field.key] = normalizeFieldValue(field, values[field.key] ?? ``);
        touched.add(field.key);
    };
    // Editing by hand outdates the paste summary.
    const onFieldInput = (field: CapabilityField): void => {
        delete pasteNotes[field.key];
    };
    // A paste recognisably holding more than one field (an ssh command, connection string, deep link, known-provider
    // email) fills every field it can and notes where; anything else falls through to an ordinary paste.
    const onFieldPaste = (field: CapabilityField, event: ClipboardEvent): void => {
        const entry = selected.value;
        const text = event.clipboardData?.getData(`text`) ?? ``;
        if (entry === undefined || text.trim() === ``) {
            return;
        }
        const expansion = expandPaste(entry, field, values, text);
        if (expansion === undefined) {
            return;
        }
        event.preventDefault();
        Object.assign(values, expansion.values);
        pasteNotes[field.key] = expansion.summary;
    };
    const refusal = (field: CapabilityField) =>
        fieldRefusal(field, values[field.key], keptSecrets.value, { touched: touched.has(field.key), attempted: attempted.value });
    // Defined only while a URL field points at the container itself; the one-click localhost fix.
    const fieldUrlFix = (field: CapabilityField): string | undefined => containerUrlFix(field, values[field.key]);

    // A device's access as a posture: a preset sets all the switches at once; a hand-tuned mix matches no preset.
    const hostPresetOptions = hostPresets().map((preset) => ({ value: preset.key, label: preset.label }));

    const canSubmit = computed(
        () => selected.value !== undefined && !nameCollision.value && formComplete(selected.value, values, name.value, keptSecrets.value),
    );

    return {
        name,
        nameEdited,
        savedName,
        namePreview,
        nameCollision,
        nameProblem,
        values,
        keptSecrets,
        attempted,
        shaking,
        pasteNotes,
        advancedOpen,
        probeResult,
        canSubmit,
        finishName,
        finishField,
        onFieldInput,
        onFieldPaste,
        fieldAlarm: (field: CapabilityField): string | undefined => refusal(field).alarm,
        fieldQuiet: (field: CapabilityField): boolean => refusal(field).quiet,
        // Green check beside a label for values a rule can vouch for (a URL that parses, a full sha, a port in range).
        fieldChecked: (field: CapabilityField): boolean => fieldVerified(field, values[field.key]),
        fieldUrlFix,
        applyUrlFix: (field: CapabilityField): void => {
            const fix = fieldUrlFix(field);
            if (fix !== undefined) {
                values[field.key] = fix;
            }
        },
        // What a WireGuard blob actually holds, read live so the check happens in the box, not after a failed connect.
        fieldConfSummary: (field: CapabilityField) => {
            const entry = selected.value;
            return entry !== undefined && summarisesWireguard(entry, field) ? wireguardSummary(values[field.key]) : undefined;
        },
        fieldPlaceholder: (field: CapabilityField): string | undefined => placeholderFor(field, values[field.key], keptSecrets.value),
        // Main fields are the tile's actual questions; advanced ones fold behind one line.
        mainFields: (entry: CapabilityCatalogEntry): readonly CapabilityField[] =>
            shownFields(entry, values).filter((field) => field.advanced !== true),
        advancedFields: (entry: CapabilityCatalogEntry): readonly CapabilityField[] =>
            shownFields(entry, values).filter((field) => field.advanced === true),
        versionToken: computed(() => versionReadToken(values, keptSecrets.value)),
        // What the answers compose into (a spending policy, a RAM bill), kept current with what submit agrees to.
        formSummary: computed(() => answersSummary(selected.value?.kind, values)),
        liveEffects: computed(() => (selected.value === undefined ? [] : formEffects(selected.value, values, name.value, contributionOf, manifestOf))),
        hostPresetOptions,
        applyHostPreset: (key: string): void => {
            const preset = hostPresets().find((candidate) => candidate.key === key);
            if (preset !== undefined) {
                Object.assign(values, preset.grants);
            }
        },
        // Fills the form from a registry pick in <PluginRegistryBrowse>.
        applyRegistryPick: (answers: { name: string; url: string; ref: string; path: string; token: string }): void => {
            name.value = answers.name;
            nameEdited.value = true;
            values[`url`] = answers.url;
            values[`ref`] = answers.ref;
            values[`path`] = answers.path;
            values[`token`] = answers.token;
        },
        // Fills the form from an imported FortiClient connection, whose credentials FortiClient encrypts: `needs` marks
        // what still needs typing, and an open edit's old password must not silently apply to the imported gateway.
        pickForticlient: (connection: ForticlientConnection): void => {
            name.value = connection.id;
            nameEdited.value = true;
            keptSecrets.value = new Set<string>();
            Object.assign(values, forticlientAnswers(selected.value?.fields ?? [], connection));
            // Land on the fields still needed, not the top of the form.
            touched.clear();
        },
        auditable: computed(() => auditOffered(selected.value?.kind, values)),
        updateFrom: computed(() => replacedPin(selected.value?.kind, editing.value, values)),
        submitLabel: computed(() => submitWord(editing.value !== undefined, selected.value?.kind)),
        // Every box counts as visited from a submit on; a refusal past this point is one the reader is shown.
        touchAll: (): void => {
            touched.add(`name`);
            if (selected.value === undefined) {
                return;
            }
            for (const field of shownFields(selected.value, values)) {
                touched.add(field.key);
            }
        },
        // The submit as refused: raise the alarm tier, so from here on a required-but-empty box is the thing actually
        // blocking the reader and is allowed to say so in red, and make the refusal visible.
        refuse: (entry: CapabilityCatalogEntry): void => {
            attempted.value = true;
            if (refusedInFold(entry, values, keptSecrets.value)) {
                advancedOpen.value = true;
            }
            shaking.value = false;
            void nextTick(() => {
                shaking.value = true;
            });
        },
        // A pending add is the one path that leaves the form up, so it resets down to the next free name.
        startOver: (entry: CapabilityCatalogEntry): void => {
            clear();
            name.value = suggestName(entry, instancesOf(entry, capabilities.value));
        },
        // The service has named the account: a name nobody typed yet follows it (`github-ada`, not `github-2`).
        heardWho: (entry: CapabilityCatalogEntry, who: string): void => {
            probedWho.value = who;
            resuggest(entry);
        },
    };
};

export type CapabilityForm = ReturnType<typeof useCapabilityForm>;

// A file dropped outside the FortiClient import zone would navigate the tab away with a half-filled form; the page
// swallows page-wide drags, and the zone's own handler still gets its file.
export const swallowFileDrag = (event: DragEvent): void => {
    if (event.dataTransfer?.types.includes(`Files`) === true) {
        event.preventDefault();
    }
};
