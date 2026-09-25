import type { SandboxSettings } from "@intentic/api-contract";
import type { OffloadKind, RunnerSummary } from "@intentic/sandbox-contract";
import type { PickerOption } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";

// The rows of "Where heavy work runs" (settings `offload`): one per kind of heavy work this sandbox queues, and one for
// the check after landing, each picking this sandbox or a runner on one of the owner's machines. Kept apart from the
// component so the choices and what a pick writes are pinned without mounting it.

type Offload = SandboxSettings[`offload`];

// "" is this sandbox: a Picker value has to be a string, and an absent key is exactly what running here means.
export const HERE = ``;

// The words for the kinds the shipped rules name; a kind the owner added to heavy-commands.json reads as its own id.
const KIND_TITLES: Readonly<Record<string, () => string>> = {
    "repo-verify": () => t(`sandbox.agentOffload.kindVerify`),
    "bun-test": () => t(`sandbox.agentOffload.kindBunTest`),
    vitest: () => t(`sandbox.agentOffload.kindVitest`),
    typechecker: () => t(`sandbox.agentOffload.kindTypecheck`),
    "turbo-fanout": () => t(`sandbox.agentOffload.kindTurbo`),
    "package-script": () => t(`sandbox.agentOffload.kindPackageScript`),
};
export const kindTitle = (kind: OffloadKind): string => KIND_TITLES[kind.id]?.() ?? kind.id;

// What each shipped kind catches, in words; one the owner added is described by its own pattern.
const KIND_DETAILS: Readonly<Record<string, () => string>> = {
    "repo-verify": () => t(`sandbox.agentOffload.kindVerifyDetail`),
    "bun-test": () => t(`sandbox.agentOffload.kindBunTestDetail`),
    vitest: () => t(`sandbox.agentOffload.kindVitestDetail`),
    typechecker: () => t(`sandbox.agentOffload.kindTypecheckDetail`),
    "turbo-fanout": () => t(`sandbox.agentOffload.kindTurboDetail`),
    "package-script": () => t(`sandbox.agentOffload.kindPackageScriptDetail`),
};
export const kindDetail = (kind: OffloadKind): string => KIND_DETAILS[kind.id]?.() ?? t(`sandbox.agentOffload.kindCustomDetail`, { pattern: kind.pattern });

// The machine a runner sits on, the word the owner knows it by; a runner started by hand has only its id.
export const runnerName = (runner: Pick<RunnerSummary, `id` | `host`>): string => runner.host ?? runner.id;

// This sandbox first, then every runner, an offline one still offered (a choice made now binds once it is back) but
// saying so.
export const targetOptions = (runners: readonly RunnerSummary[]): PickerOption<string>[] => [
    { value: HERE, label: t(`sandbox.agentOffload.here`), icon: `server` },
    ...runners.map((runner) => ({
        value: runner.id,
        label: runnerName(runner),
        icon: `desktop` as const,
        description: runner.online ? t(`sandbox.agentOffload.runnerOnline`) : t(`sandbox.agentOffload.runnerOffline`),
    })),
];

// What a pick writes: this sandbox removes the kind's entry, a runner sets it; every other kind stays as it was.
export const withCommandTarget = (offload: Offload, kind: string, runner: string): Offload => {
    const commands: Record<string, string> = { ...offload.commands };
    if (runner === HERE) {
        delete commands[kind];
    } else {
        commands[kind] = runner;
    }
    return { ...offload, commands };
};

export const withLandCheckTarget = (offload: Offload, runner: string): Offload => {
    const { landCheck: _dropped, ...rest } = offload;
    return runner === HERE ? rest : { ...rest, landCheck: runner };
};

// A pick naming a runner that is offline, or no longer set up: the work runs here until it is back, which the row says.
export const unavailableRunner = (runner: string | undefined, runners: readonly RunnerSummary[]): string | undefined => {
    if (runner === undefined || runner === HERE) {
        return undefined;
    }
    const known = runners.find((entry) => entry.id === runner);
    if (known === undefined) {
        return t(`sandbox.agentOffload.runnerGone`, { runner });
    }
    return known.online ? undefined : t(`sandbox.agentOffload.runsHereUntilBack`, { machine: runnerName(known) });
};
