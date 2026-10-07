import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { WatchState } from "@intentic/sandbox-contract";
import { classifyCommand } from "@intentic/sandbox-contract";
import { WORKSPACE_ROOT_EXCLUDE_ENV } from "@intentic/sandbox-contract/chores";
import { wrapOutsideContent } from "@intentic/base/outside-text";
import { REFERENCE_DIR } from "@intentic/workspace-ignore";
import type { Services } from "../../composition.js";
import { statePath } from "../../state-paths.js";
import { outputTail, runCheck, shellArgv } from "../../workload/run-check.js";
import type { AutomationRecord } from "../automations-store.js";
import { guardCapabilityEnv } from "./guard-env.js";
import { checkSource, sourceLabel } from "./watch-sources.js";

// The check in front of every automation that has one, and the only part of a watch that runs while nothing has
// happened: a guard command or a ready-made source (watch-sources.ts), never a model. It decides whether this fire
// goes ahead, remembers what it saw (automations-store.ts recordWatch), and words what it saw for whoever is woken, so
// "Bun 1.4.3 is out" arrives as that sentence rather than as a bare "your guard passed".

// How long a guard command may run before it counts as failed (skipping the wake).
const GUARD_TIMEOUT_MS = 60_000;
// Output a guard may print per stream; past it the guard fails (execFile's default maxBuffer, which it ran under).
const GUARD_CAPTURE_BYTES = 1024 * 1024;
// How much of a check's words survive into the run's detail.
const DETAIL_TAIL = 500;
// How much of what a check saw reaches the woken prompt; a page longer than this is summarised by its diff instead.
const OBSERVED_MAX = 12_000;
// Lines of a diff listed on each side before the rest is counted.
const DIFF_LINES = 60;
// Where `fireOn: change` names the outside source of a fetching guard's words.
const GUARD_FETCH = "automation-guard-fetch";

// What a check came to. `go`: fire, with what it saw worded for the wake (absent when it saw nothing worth saying).
// `skip`: record a skipped run saying why. `quiet`: nothing moved since last time, which a frequent watch would
// otherwise write into its history every few minutes.
export type ConditionVerdict =
    | { readonly kind: "go"; readonly observed?: string; readonly outside?: string; readonly value?: string }
    | { readonly kind: "skip"; readonly detail: string }
    | { readonly kind: "quiet"; readonly detail: string };

// What the check is, in a line: the source's own label, or the guard command itself.
export const conditionLabel = (automation: Pick<AutomationRecord, "source" | "guard">): string | undefined =>
    automation.source !== undefined ? sourceLabel(automation.source) : automation.guard;

// The file a guard may keep between runs; the daemon makes its directory and never reads it.
export const guardStateFile = (root: string, id: string): string => statePath(root, ".intentic/records/automation-state/", id);

const firstLine = (text: string, max = 160): string => {
    const line =
        text
            .split("\n")
            .find((entry) => entry.trim() !== "")
            ?.trim() ?? "";
    return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
};

// A guard's environment: the daemon's own, what the trigger carried, its state file and last output, and the connector
// credentials an unattended turn of this automation would get (guard-env.ts). Credentials that cannot be resolved are
// left out and logged rather than failing the guard, which may well need none.
const guardEnv = async (services: Services, automation: AutomationRecord, payload: string | undefined): Promise<NodeJS.ProcessEnv> => {
    const capabilities = await guardCapabilityEnv(services, automation).catch((error: unknown) => {
        services.logger.warn(
            { err: error, automation: automation.id },
            "automation guard: connector credentials could not be resolved, it runs without them",
        );
        return {};
    });
    const stateFile = guardStateFile(services.workspace.root, automation.id);
    await mkdir(join(stateFile, ".."), { recursive: true });
    return {
        ...process.env,
        ...capabilities,
        // A guard runs at the workspace root, where refs/ is reference material its scanners skip.
        [WORKSPACE_ROOT_EXCLUDE_ENV]: REFERENCE_DIR,
        AUTOMATION_STATE: stateFile,
        ...(automation.watch?.value !== undefined ? { AUTOMATION_LAST: automation.watch.value } : {}),
        ...(payload !== undefined ? { AUTOMATION_PAYLOAD: payload } : {}),
    };
};

// What a ready-made source reads its way in from: the daemon's environment with the same connector credentials a guard of
// this automation would get, so a connected GitHub card answers for a releases check (watch-sources.ts githubApi).
export const sourceEnv = async (
    services: Services,
    automation: Pick<AutomationRecord, "id" | "actsAs">,
): Promise<Record<string, string | undefined>> => ({
    ...process.env,
    ...(await guardCapabilityEnv(services, automation).catch((error: unknown) => {
        services.logger.warn(
            { err: error, automation: automation.id },
            "automation source: connector credentials could not be resolved, it checks without them",
        );
        return {};
    })),
});

type Checked = { readonly pass: true; readonly output: string } | { readonly pass: false; readonly detail: string };

// Exit 0 passes, with what it printed on stdout; anything else is what it is still waiting for, in its own words.
const runGuard = async (services: Services, automation: AutomationRecord, command: string, payload: string | undefined): Promise<Checked> => {
    const ran = await runCheck({
        argv: shellArgv(command, "sh"),
        cwd: services.workspace.root,
        timeoutMs: GUARD_TIMEOUT_MS,
        env: await guardEnv(services, automation, payload),
        workload: { class: "command" },
        kind: "automation-guard",
        captureBytes: GUARD_CAPTURE_BYTES,
        // Output past the cap fails the guard, as execFile's maxBuffer did.
        killOnOverflow: true,
    });
    if (ran.exitCode === 0 && !ran.truncated) {
        return { pass: true, output: ran.stdout.trim() };
    }
    return { pass: false, detail: outputTail(ran, DETAIL_TAIL) || (ran.spawnError ?? "") };
};

// Lines only on one side, each side listed up to DIFF_LINES: what a reader needs to see what moved, not an edit script.
export const lineDiff = (before: string, after: string): string => {
    const was = new Set(before.split("\n"));
    const now = new Set(after.split("\n"));
    const gone = [...was].filter((line) => !now.has(line) && line.trim() !== "");
    const came = [...now].filter((line) => !was.has(line) && line.trim() !== "");
    const listed = (lines: readonly string[], mark: string): string[] => [
        ...lines.slice(0, DIFF_LINES).map((line) => `${mark} ${line}`),
        ...(lines.length > DIFF_LINES ? [`${mark} … and ${lines.length - DIFF_LINES} more lines`] : []),
    ];
    return [...listed(gone, "-"), ...listed(came, "+")].join("\n");
};

const capped = (text: string): string =>
    text.length <= OBSERVED_MAX ? text : `${text.slice(0, OBSERVED_MAX)}\n… (${text.length - OBSERVED_MAX} more characters)`;

// What the wake is told it saw: the value, or for a change what it was and what it is now. Words from outside are wrapped
// as such, the same envelope a fetching watch check's output gets.
const observedOf = (value: string, previous: string | undefined, outside: string | undefined): string | undefined => {
    const seal = (text: string): string => (outside === undefined ? text : wrapOutsideContent(text, { source: outside }));
    if (previous === undefined) {
        return value === "" ? undefined : seal(capped(value));
    }
    const short = !value.includes("\n") && !previous.includes("\n") && value.length < 300 && previous.length < 300;
    if (short) {
        return `It was: ${seal(previous)}\nIt is now: ${seal(value)}`;
    }
    return `What changed since the last check (- gone, + new):\n${seal(capped(lineDiff(previous, value)))}\n\nWhat it sees now:\n${seal(capped(value))}`;
};

// Where a check's words come from when they come from outside: every source fetches; a guard does when the command
// reaches the network, by the same classification a watch check is judged by.
export const conditionOutside = (automation: Pick<AutomationRecord, "source" | "guard">): string | undefined => {
    if (automation.source !== undefined) {
        return `automation-${automation.source.kind}`;
    }
    return automation.guard !== undefined && classifyCommand(automation.guard, { locus: "sandbox" }).includes("network.outbound")
        ? GUARD_FETCH
        : undefined;
};

const remember = (services: Services, id: string, now: number, change: (previous: WatchState | undefined) => Partial<WatchState>): Promise<void> =>
    services.automations.recordWatch(id, (previous) => {
        const { waiting: _waiting, ...kept } = previous ?? { armedAt: now, checkedAt: now };
        return { ...kept, armedAt: previous?.armedAt ?? now, checkedAt: now, ...change(previous) };
    });

// Runs the automation's check, if it has one, and decides. An automation with neither a guard nor a source goes ahead
// with nothing to say, exactly as before watches existed.
export const checkCondition = async (services: Services, automation: AutomationRecord, payload: string | undefined): Promise<ConditionVerdict> => {
    if (automation.source === undefined && automation.guard === undefined) {
        return { kind: "go" };
    }
    const checked: Checked =
        automation.source !== undefined
            ? await checkSource(automation.source, { fetch: (url, init) => fetch(url, init), env: await sourceEnv(services, automation) })
            : await runGuard(services, automation, automation.guard as string, payload);
    const now = Date.now();
    // Read fresh rather than off the record the tick handed over: two fires of a busy automation queue behind one
    // another, and the second must compare against what the first just saw.
    const previous = (await services.automations.get(automation.id))?.watch;
    if (!checked.pass) {
        await remember(services, automation.id, now, () => ({ waiting: firstLine(checked.detail) || "the check did not pass" }));
        return { kind: "skip", detail: checked.detail };
    }
    const value = checked.output;
    const outside = conditionOutside(automation);
    if (automation.fireOn === "change") {
        if (previous?.value === undefined) {
            await remember(services, automation.id, now, () => ({ value, changedAt: now }));
            return {
                kind: "skip",
                detail: `First check: noted ${firstLine(value) === "" ? "an empty answer" : `"${firstLine(value)}"`} to compare against from now on.`,
            };
        }
        if (previous.value === value) {
            await remember(services, automation.id, now, () => ({}));
            return { kind: "quiet", detail: `Unchanged: still ${firstLine(value) === "" ? "empty" : `"${firstLine(value)}"`}.` };
        }
        await remember(services, automation.id, now, () => ({ value, changedAt: now, firedAt: now }));
        const observed = observedOf(value, previous.value, outside);
        return { kind: "go", value, ...(observed === undefined ? {} : { observed }), ...(outside === undefined ? {} : { outside }) };
    }
    await remember(services, automation.id, now, (before) => ({
        value,
        changedAt: before?.value === value ? (before.changedAt ?? now) : now,
        firedAt: now,
    }));
    const observed = observedOf(value, undefined, outside);
    return { kind: "go", value, ...(observed === undefined ? {} : { observed }), ...(outside === undefined ? {} : { outside }) };
};

// How long ago, in the unit a person reads it in.
export const sinceLabel = (ms: number): string => {
    const minutes = Math.max(0, Math.round(ms / 60_000));
    if (minutes < 120) {
        return `${minutes}m`;
    }
    const hours = Math.round(minutes / 60);
    return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
};
