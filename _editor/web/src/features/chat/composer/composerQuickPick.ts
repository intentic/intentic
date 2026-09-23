import { type AgentProvider, type CatalogOption, type Persona, providerLabel } from "@intentic/sandbox-contract";
import type { IconName } from "@intentic/ui";
import { filterEntries, normalize, type PickerEntry } from "../models/modelPickerState";
import { QUICK_KINDS, type QuickKind } from "./useMentions";
import { t } from "@intentic/ui/i18n";

// The rows the composer's `@` token offers besides files: the four turn settings, as one pure derivation over plain
// data. A kind whose source is undefined is not offered at all (the pill row refuses it too), so it appears in
// neither the summary nor a search. Files are the component's own list, appended after these.

export const kindMeta = (): Record<QuickKind, { readonly label: string; readonly badge: string; readonly icon: IconName }> => ({
    persona: { label: t(`shared.acts`), badge: `Persona`, icon: `users` },
    sandbox: { label: t(`shared.whereRuns`), badge: `Where`, icon: `desktop` },
    model: { label: t(`shared.model`), badge: `Model`, icon: `cpu` },
    effort: { label: t(`chat.composerQuickPick.effort`), badge: `Effort`, icon: `bolt` },
});

export interface QuickPickSources {
    readonly persona: { readonly personas: readonly Persona[]; readonly picked: string | undefined } | undefined;
    readonly sandbox:
        | {
              // Online runners and answering boxes only: a keyboard list has no use for a row that refuses the pick.
              readonly runners: readonly { readonly id: string }[];
              readonly boxes: readonly { readonly id: string; readonly name: string }[];
              readonly box: string | undefined;
              readonly runner: string | undefined;
          }
        | undefined;
    readonly model:
        | {
              // Already narrowed to what this conversation may switch to (mid-stream: same provider only).
              readonly entries: readonly PickerEntry[];
              readonly provider: AgentProvider;
              readonly model: string;
              // What the current pick is called, by the app's one naming rule (providerCatalog.modelLabelFor).
              readonly label: string;
              readonly isReady: (provider: AgentProvider) => boolean;
          }
        | undefined;
    readonly effort: { readonly options: readonly CatalogOption[]; readonly picked: string } | undefined;
}

interface RowBase {
    readonly key: string;
    readonly label: string;
    readonly detail: string | undefined;
}
// A summary row: the kind's current value; picking it drills into that kind.
type DrillRow = RowBase & { readonly kind: `drill`; readonly into: QuickKind };
type PersonaRow = RowBase & { readonly kind: `persona`; readonly id: string | undefined; readonly current: boolean };
type SandboxRow = RowBase & {
    readonly kind: `sandbox`;
    readonly box: string | undefined;
    readonly runner: string | undefined;
    readonly current: boolean;
};
type ModelRow = RowBase & { readonly kind: `model`; readonly entry: PickerEntry; readonly current: boolean };
type EffortRow = RowBase & { readonly kind: `effort`; readonly value: string; readonly current: boolean };
export type QuickRow = DrillRow | PersonaRow | SandboxRow | ModelRow | EffortRow;
// Everything the popover can hand back: a setting row, or a file from its own list.
export type QuickPick = QuickRow | { readonly kind: `file`; readonly key: string; readonly path: string };

// Flat search shows the few rows that could be meant; a drilled kind shows its whole list, scrolled.
export const FLAT_MODEL_ROWS = 4;
export const DRILLED_ROWS = 12;

// Names and ids only, never a detail line: prose under a row would match on almost any letter.
const matches = (query: string, ...texts: (string | undefined)[]): boolean => {
    const needle = normalize(query);
    return needle === `` || texts.some((text) => text !== undefined && normalize(text).includes(needle));
};

const personaRows = (source: NonNullable<QuickPickSources[`persona`]>, query: string): PersonaRow[] => {
    const rows: PersonaRow[] = [
        {
            kind: `persona`,
            key: `persona:`,
            id: undefined,
            label: t(`shared.anyone`),
            detail: t(`chat.composerQuickPick.everyConnectedAccount`),
            current: source.picked === undefined,
        },
        ...source.personas.map((persona): PersonaRow => ({
            kind: `persona`,
            key: `persona:${persona.id}`,
            id: persona.id,
            label: persona.label ?? persona.id,
            detail: persona.brief ?? (persona.capabilities.length > 0 ? persona.capabilities.join(` · `) : undefined),
            current: source.picked === persona.id,
        })),
    ];
    return rows.filter((row) => matches(query, row.label, row.id));
};

const sandboxRows = (source: NonNullable<QuickPickSources[`sandbox`]>, query: string): SandboxRow[] => {
    const here = source.box === undefined && source.runner === undefined;
    const rows: SandboxRow[] = [
        {
            kind: `sandbox`,
            key: `sandbox:`,
            box: undefined,
            runner: undefined,
            label: t(`shared.sandbox`),
            detail: t(`chat.composerQuickPick.here`),
            current: here,
        },
        ...source.runners.map((runner): SandboxRow => ({
            kind: `sandbox`,
            key: `sandbox:runner:${runner.id}`,
            box: undefined,
            runner: runner.id,
            label: runner.id,
            detail: t(`chat.composerQuickPick.runnerOnComputer`),
            current: source.runner === runner.id,
        })),
        ...source.boxes.map((box): SandboxRow => ({
            kind: `sandbox`,
            key: `sandbox:box:${box.id}`,
            box: box.id,
            runner: undefined,
            label: box.name,
            detail: t(`chat.composerQuickPick.anotherSandbox`),
            current: source.box === box.id,
        })),
    ];
    return rows.filter((row) => matches(query, row.label));
};

const modelRow = (source: NonNullable<QuickPickSources[`model`]>, entry: PickerEntry): ModelRow => ({
    kind: `model`,
    key: `model:${entry.key}`,
    entry,
    label: entry.label,
    detail: providerLabel(entry.provider),
    current: entry.provider === source.provider && entry.value === source.model,
});

// The model list's own ranking (filterEntries); the current pair leads an unfiltered list so its tick is in view.
const modelRows = (source: NonNullable<QuickPickSources[`model`]>, query: string): ModelRow[] => {
    const ranked = filterEntries(source.entries, query, undefined, source.isReady);
    const rows = ranked.map((entry) => modelRow(source, entry));
    if (query.trim() !== ``) {
        return rows;
    }
    const current = rows.findIndex((row) => row.current);
    return current <= 0 ? rows : [rows[current]!, ...rows.slice(0, current), ...rows.slice(current + 1)];
};

const effortRows = (source: NonNullable<QuickPickSources[`effort`]>, query: string): EffortRow[] =>
    source.options
        .map((option): EffortRow => ({
            kind: `effort`,
            key: `effort:${option.value}`,
            value: option.value,
            label: option.label,
            detail: undefined,
            current: source.picked === option.value,
        }))
        .filter((row) => matches(query, row.label, row.value));

const rowsOf = (sources: QuickPickSources, kind: QuickKind, query: string): QuickRow[] => {
    switch (kind) {
        case `persona`:
            return sources.persona === undefined ? [] : personaRows(sources.persona, query);
        case `sandbox`:
            return sources.sandbox === undefined ? [] : sandboxRows(sources.sandbox, query);
        case `model`:
            return sources.model === undefined ? [] : modelRows(sources.model, query);
        case `effort`:
            return sources.effort === undefined ? [] : effortRows(sources.effort, query);
    }
};

// What each kind is set to now, as the summary row's second word; a pick no list names (a deleted persona) shows its
// raw id rather than nothing.
const personaValue = (source: NonNullable<QuickPickSources[`persona`]>): string => {
    const persona = source.personas.find((candidate) => candidate.id === source.picked);
    return persona === undefined ? (source.picked ?? `Anyone`) : (persona.label ?? persona.id);
};
const sandboxValue = (source: NonNullable<QuickPickSources[`sandbox`]>): string => {
    if (source.box !== undefined) {
        return source.boxes.find((box) => box.id === source.box)?.name ?? `Another sandbox`;
    }
    return source.runner ?? `Here`;
};
const effortValue = (source: NonNullable<QuickPickSources[`effort`]>): string =>
    source.options.find((option) => option.value === source.picked)?.label ?? source.picked;

const currentValue = (sources: QuickPickSources, kind: QuickKind): string | undefined => {
    switch (kind) {
        case `persona`:
            return sources.persona === undefined ? undefined : personaValue(sources.persona);
        case `sandbox`:
            return sources.sandbox === undefined ? undefined : sandboxValue(sources.sandbox);
        case `model`:
            return sources.model?.label;
        case `effort`:
            return sources.effort === undefined ? undefined : effortValue(sources.effort);
    }
};

const summaryRows = (sources: QuickPickSources, query: string): DrillRow[] =>
    QUICK_KINDS.flatMap((kind): DrillRow[] => {
        const value = currentValue(sources, kind);
        if (value === undefined) {
            return [];
        }
        const meta = kindMeta()[kind];
        return matches(query, kind, meta.label, meta.badge)
            ? [{ kind: `drill`, key: `drill:${kind}`, into: kind, label: meta.label, detail: value }]
            : [];
    });

// The setting rows for one token. Empty: one summary row per offered kind. Drilled (`model:son`): that kind alone,
// its list capped for scrolling. Typing (`son`): the summary rows the word names, then each kind's matches in kind
// order, models capped so files below stay within reach.
export const quickRows = (
    sources: QuickPickSources,
    token: { readonly kind: QuickKind | undefined; readonly query: string },
): readonly QuickRow[] => {
    if (token.kind !== undefined) {
        return rowsOf(sources, token.kind, token.query).slice(0, DRILLED_ROWS);
    }
    if (token.query === ``) {
        return summaryRows(sources, ``);
    }
    return [
        ...summaryRows(sources, token.query),
        ...QUICK_KINDS.flatMap((kind) => {
            const rows = rowsOf(sources, kind, token.query);
            return kind === `model` ? rows.slice(0, FLAT_MODEL_ROWS) : rows;
        }),
    ];
};
