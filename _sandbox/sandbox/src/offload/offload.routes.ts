import { type OffloadFrame, type OffloadRecord, type OffloadTarget, offloadContract } from "@intentic/sandbox-contract";
import { implement } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";

/* THIS SANDBOX'S SIDE OF AN OFFLOADED COMMAND (settings `offload`). The in-sandbox `offload-run` command asks whether the
   runner a kind of heavy work goes to can take it, snapshots the tree, then runs the line through here, which relays it
   to that runner (runners/runner-command.ts) and streams its frames back unchanged. Nothing here decides WHAT goes where:
   the Bash hook and the check after landing already put `offload-run --to <runner>` in front of the line from the
   setting. A runner that cannot take it answers with one refusal, and `offload-run` runs the line here instead. */

export type OffloadDeps = Pick<Services, "runners" | "runnerHub" | "logger" | "heavyCommands">;

// Recent runs the runner card lists; a few dozen is enough to see what went where, and it is all in memory.
const RECORDS_KEPT = 40;
const COMMAND_SHOWN = 160;

// The word the owner picked the runner by: the machine that asked for it, else its own id.
const nameOf = async (deps: OffloadDeps, runner: string): Promise<string> => {
    const enrolled = (await deps.runners.list()).find((entry) => entry.id === runner);
    return enrolled?.host ?? runner;
};

export const offloadTarget = async (deps: OffloadDeps, runner: string): Promise<OffloadTarget> => {
    const name = await nameOf(deps, runner);
    const enrolled = (await deps.runners.list()).some((entry) => entry.id === runner);
    if (!enrolled) {
        return { runner, name, ready: false, why: `no runner "${runner}" is set up any more` };
    }
    if (deps.runnerHub.client(runner) === undefined) {
        return { runner, name, ready: false, why: `${name} is offline (the machine is asleep or its runner is stopped)` };
    }
    return { runner, name, ready: true };
};

// A runner that predates offloading has no such procedure; oRPC says so in its own words.
const isMissingProcedure = (error: unknown): boolean => /not.?found|no procedure|unknown procedure/iu.test(error instanceof Error ? error.message : String(error));

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
        target: i.target.handler(async ({ input }) => await offloadTarget(deps, input.runner)),
        run: i.run.handler(async function* ({ input, signal }): AsyncGenerator<OffloadFrame> {
            const { runner, ...command } = input;
            const target = await offloadTarget(deps, runner);
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
                            ...(frame.failure === undefined ? {} : { failure: frame.failure }),
                        });
                    }
                    yield frame;
                }
            } catch (error) {
                const why = isMissingProcedure(error)
                    ? `the runner on ${target.name} predates offloading; update it from Devices`
                    : `the link to ${target.name} failed: ${error instanceof Error ? error.message : String(error)}`;
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
            await client?.cancelCommand({ runId: input.runId }).catch(() => undefined);
            return { ok: true } as const;
        }),
        runs: i.runs.handler(() => ({ runs: records.map((entry) => ({ ...entry })) })),
        // The rules the queue applies, less the ones that exempt a line from it (a search, a dev server): those never
        // queue, so they are never heavy work to send anywhere.
        kinds: i.kinds.handler(async () => ({
            kinds: (await deps.heavyCommands.read()).rules.filter((rule) => rule.exempt !== true).map(({ id, pattern }) => ({ id, pattern })),
        })),
    };
};
