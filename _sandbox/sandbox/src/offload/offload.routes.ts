import { errorMessage } from "@intentic/base/errors";
import {
    OFFLOAD_ANY_RUNNER,
    type OffloadFrame,
    type OffloadNeeds,
    type OffloadRecord,
    type OffloadTarget,
    type OffloadTargetInput,
} from "@intentic/sandbox-contract/schemas/offload";
import { offloadContract } from "@intentic/sandbox-contract/contracts/offload.contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";
import { areasOf } from "../auth/principal.js";
import { type FleetAdviceDeps, fitsNeeds, fleetAdvice, placeCommand } from "../runners/fleet-advice.js";
import { opt } from "../opt.js";

/* THIS SANDBOX'S SIDE OF AN OFFLOADED COMMAND (settings `offload`). The in-sandbox `offload-run` command asks whether the
   runner a kind of heavy work goes to can take it, snapshots the tree, then runs the line through here, which relays it
   to that runner (runners/runner-command.ts) and streams its frames back unchanged. Nothing here decides WHAT goes where:
   the Bash hook already put `offload-run --to <runner>` in front of the line from the setting. A runner that cannot take
   it answers with one refusal, and `offload-run` runs the line here instead. The one decision made here is for a kind
   sent to "any machine with room" (OFFLOAD_ANY_RUNNER) or asked for with `remote-run`: which runner, if any, at the
   moment the line starts, by what it needs (said, and measured on its earlier runs: command-profiles.ts) and how full
   each machine is (runners/fleet-advice.ts `placeCommand`). Each run's measurements go back into its profile. */

export type OffloadDeps = Pick<Services, "runners" | "runnerHub" | "logger" | "heavyCommands" | "commandProfiles"> & FleetAdviceDeps;

// Recent runs the runner card lists; a few dozen is enough to see what went where, and it is all in memory.
const RECORDS_KEPT = 40;
const COMMAND_SHOWN = 160;

// The word the owner picked the runner by: the machine that asked for it, else its own id.
const nameOf = async (deps: OffloadDeps, runner: string): Promise<string> => {
    const enrolled = (await deps.runners.list()).find((entry) => entry.id === runner);
    return enrolled?.host ?? runner;
};

// What the line needs: what its caller said, raised to what the same kind of line held on its last runs.
const askOf = async (deps: OffloadDeps, input: OffloadTargetInput): Promise<{ readonly needs: OffloadNeeds; readonly durationMs?: number | undefined }> => {
    // allow(silent-catch): an unreadable profile file places the line by what was said alone
    const profile = input.label === undefined || input.command === undefined ? undefined : await deps.commandProfiles.lookup(input.label, input.command).catch(() => undefined);
    const memoryMb = Math.max(input.memoryMb ?? 0, profile?.peakMemoryMb ?? 0);
    return { needs: { ...opt("memoryMb", memoryMb > 0 ? memoryMb : undefined), ...opt("gpu", input.gpu === true ? true : undefined) }, durationMs: profile?.durationMs };
};

// "Any machine with room": the runner the fleet reading picks, else here, without a word while this sandbox has room
// (a calm sandbox running its own tests is not news), with one when the caller should hear why (`remote-run` that
// found no runner, a line no machine fits). A pick that fails the checks below by the time it is asked is said too.
const anyTarget = async (deps: OffloadDeps, input: OffloadTargetInput): Promise<OffloadTarget> => {
    const ask = await askOf(deps, input);
    let picked: Awaited<ReturnType<typeof placeCommand>>;
    try {
        picked = await placeCommand(deps, { ...ask, eager: input.eager === true });
    } catch (error) {
        deps.logger.warn({ err: error }, "offload: the fleet could not be read, the line runs here");
        picked = {};
    }
    if (picked.runner === undefined) {
        return { runner: OFFLOAD_ANY_RUNNER, name: "this sandbox", ready: false, ...opt("why", picked.why) };
    }
    return await offloadTarget(deps, { ...input, runner: picked.runner });
};

// A runner named outright is still checked against what the line needs: a build that needs a GPU is not sent to a
// machine without one because the setting named it.
const shortOf = async (deps: OffloadDeps, input: OffloadTargetInput, runner: string, name: string): Promise<string | undefined> => {
    const { needs } = await askOf(deps, input);
    if (needs.memoryMb === undefined && needs.gpu !== true) {
        return undefined;
    }
    const facts = deps.runnerHub.state(runner).facts;
    if (facts === undefined || fitsNeeds(facts, needs, "now")) {
        return undefined;
    }
    return needs.gpu === true && (facts.gpus ?? []).length === 0
        ? `${name} has no GPU this command can use`
        : `${name} has ${String(Math.round((facts.memoryFreeMb ?? facts.memoryMb) / 1024))} GiB free and this command needs ${String(Math.round((needs.memoryMb ?? 0) / 1024))} GiB`;
};

export const offloadTarget = async (deps: OffloadDeps, input: OffloadTargetInput): Promise<OffloadTarget> => {
    const { runner } = input;
    if (runner === OFFLOAD_ANY_RUNNER) {
        return await anyTarget(deps, input);
    }
    const name = await nameOf(deps, runner);
    const enrolled = (await deps.runners.list()).some((entry) => entry.id === runner);
    if (!enrolled) {
        return { runner, name, ready: false, why: `no runner "${runner}" is set up any more` };
    }
    if (deps.runnerHub.client(runner) === undefined) {
        return { runner, name, ready: false, why: `${name} is offline (the machine is asleep or its runner is stopped)` };
    }
    const short = await shortOf(deps, input, runner, name);
    return short === undefined ? { runner, name, ready: true } : { runner, name, ready: false, why: short };
};

// A runner that predates offloading has no such procedure: its oRPC peer answers 404, which the client raises as
// NOT_FOUND. runCommand itself never throws that code, so a NOT_FOUND here is the procedure, never what it ran.
const isMissingProcedure = (error: unknown): boolean => error instanceof ORPCError && error.code === "NOT_FOUND";

export const createOffloadRoutes = (deps: OffloadDeps) => {
    const i = implement(offloadContract).$context<OrpcContext>();
    const records: OffloadRecord[] = [];
    // Which runner each live run is on, for a cancel to reach.
    const live = new Map<string, string>();

    const record = (entry: OffloadRecord): OffloadRecord => {
        records.unshift(entry);
        records.splice(RECORDS_KEPT);
        return entry;
    };

    return {
        target: i.target.handler(async ({ input }) => await offloadTarget(deps, input)),
        run: i.run.handler(async function* ({ input, signal }): AsyncGenerator<OffloadFrame> {
            const { runner, ...command } = input;
            const target = await offloadTarget(deps, { runner });
            const client = deps.runnerHub.client(runner);
            if (!target.ready || client === undefined) {
                yield { kind: "refused", why: target.why ?? `${target.name} cannot take it right now` };
                return;
            }
            const entry = record({
                runId: command.runId,
                runner,
                name: target.name,
                label: command.label,
                command: command.command.length > COMMAND_SHOWN ? `${command.command.slice(0, COMMAND_SHOWN - 1)}…` : command.command,
                startedAt: Date.now(),
            });
            live.set(command.runId, runner);
            // A caller that goes away (the command stopped, its terminal closed) stops the line on the runner too.
            // allow(silent-catch): best-effort cancel; a runner already disconnected or finished needs no recovery
            const cancel = (): void => void client.cancelCommand({ runId: command.runId }).catch(() => undefined);
            signal?.addEventListener("abort", cancel, { once: true });
            let started = false;
            try {
                for await (const frame of await client.runCommand(command)) {
                    started = true;
                    if (frame.kind === "exit") {
                        Object.assign(entry, {
                            endedAt: Date.now(),
                            code: frame.code,
                            ...opt("failure", frame.failure),
                            ...opt("peakMemoryMb", frame.peakMemoryMb),
                            ...opt("durationMs", frame.durationMs),
                        });
                        // What it took goes into its profile, which places the next run of the same kind of line.
                        if (frame.ran) {
                            deps.commandProfiles
                                .record(command.label, command.command, { peakMemoryMb: frame.peakMemoryMb, durationMs: frame.durationMs })
                                .catch((error: Error) => deps.logger.warn({ err: error }, "offload: a run's measurements could not be kept"));
                        }
                    }
                    yield frame;
                }
            } catch (error) {
                const why = isMissingProcedure(error)
                    ? `the runner on ${target.name} predates offloading; update it from Devices`
                    : `the link to ${target.name} failed: ${errorMessage(error)}`;
                Object.assign(entry, { endedAt: Date.now(), failure: why });
                deps.logger.warn({ err: error, runner, runId: command.runId }, "offload: run failed");
                // Before anything ran there, the line can still run here; after, the output already came from there.
                yield started ? { kind: "exit", code: 1, failure: why, ran: true, files: {} } : { kind: "refused", why };
            } finally {
                signal?.removeEventListener("abort", cancel);
                live.delete(command.runId);
            }
        }),
        cancel: i.cancel.handler(async ({ input }) => {
            const runner = live.get(input.runId);
            const client = runner === undefined ? undefined : deps.runnerHub.client(runner);
            // allow(silent-catch): best-effort cancel; a runner already disconnected or finished needs no recovery
            await client?.cancelCommand({ runId: input.runId }).catch(() => undefined);
            return { ok: true } as const;
        }),
        runs: i.runs.handler(() => ({ runs: records.map((entry) => ({ ...entry })) })),
        // Which machine a new session should start on; the caller's own area limit decides whether a runner can take it.
        placement: i.placement.handler(async ({ input, context }) => await fleetAdvice(deps, input, areasOf(context.identity))),
        // The rules the queue applies, less the ones that exempt a line from it (a search, a dev server): those never
        // queue, so they are never heavy work to send anywhere.
        kinds: i.kinds.handler(async () => ({
            // Never an install: it writes this sandbox's own dependencies, and a runner installs into its copy and hands
            // back only a patch, so the tree here would stay uninstalled.
            kinds: (await deps.heavyCommands.read()).rules
                .filter((rule) => rule.exempt !== true && rule.pool !== "install")
                .map(({ id, pattern, scripts }) => ({ id, pattern: pattern ?? scripts?.join(", ") ?? "" })),
        })),
    };
};
