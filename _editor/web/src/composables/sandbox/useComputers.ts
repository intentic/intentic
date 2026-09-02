import {
    type Computer,
    type MachineCommand,
    type MachineCommandResult,
    type MachineSandboxOp,
    ComputersListSchema,
    MachineCommandResultSchema,
    SyncStatusSchema,
} from "@intentic/sandbox-contract";
import { computed, type ComputedRef, type Ref } from "vue";
import { sandboxError, sandboxJson, sandboxRequest } from "./sandboxClient";
import { readIntenticLines } from "../intenticStream";
import { COMPUTERS, SYNC_HEALTH } from "../queryKeys";
import { useSandboxQuery } from "./useSandboxQuery";

/* THE COMPUTERS ON THE OTHER END OF THIS SANDBOX, every machine the daemon can see, however it can see it
 * (hosts/machine-reports.ts merges the two doors).
 *
 * This is the read that made the Desktop sync card's claims checkable. That card could say a machine was enrolled
 * and then had to print the agent's status command for the rest, because the daemon genuinely did not know which
 * folder was syncing or which ports had reached localhost. Now the machines say so themselves.
 *
 * Polled rather than pushed: the facts are a snapshot of somebody's laptop and move in seconds at most, and the
 * daemon caches the half it has to pull, so a tab left open costs the far end nothing beyond that cache's TTL. */

const QUERY_KEY = COMPUTERS.of();
const POLL_MS = 10_000;

/* WHO POLLS AND WHO ONLY READS, and it has to be a choice the caller makes.
 *
 * The rule this file states two paragraphs up, that reaching out to a machine happens because a person opened
 * the view that shows it, was true of the Computers tab and quietly false everywhere else: useHostRunning reads
 * the same query, HostRecreate calls it, and the update card renders HostRecreate whenever a release, a rollback
 * or a pending overlay is on offer. So the sandbox Overview and Environment tabs re-polled every connected
 * laptop every ten seconds to decide whether a button could be a button, and a reader who then opened Computers
 * arrived behind a fan-out that was already running.
 *
 * A non-polling reader still gets the list, and gets it instantly: whatever the shared cache holds, refreshed
 * once on mount. That is all "which computer runs this sandbox" ever needed. */
export function useComputers({ poll = true }: { poll?: boolean } = {}): {
    computers: ComputedRef<Computer[]>;
    error: ComputedRef<string | undefined>;
    isLoading: Ref<boolean>;
    refetch: () => void;
} {
    const { query, error } = useSandboxQuery({
        queryKey: QUERY_KEY,
        queryFn: async () => ComputersListSchema.parse(await sandboxJson(`/system/computers`)),
        refetchInterval: poll ? POLL_MS : false,
    });
    return {
        computers: computed(() => query.data.value?.computers ?? []),
        error,
        // The FIRST read only, a poll every ten seconds must never blank the list it is refreshing. An empty
        // `computers` is "no machine is paired" once this is false, and says nothing at all while it is true.
        isLoading: query.isLoading,
        refetch: () => void query.refetch(),
    };
}

/* One action on one machine's sandbox, and every one of them takes this door.
 *
 * They differ enormously underneath, three are a docker call that returns in a second, three run a flow that
 * pulls an image for minutes, one deletes, and not at all to the person clicking. So there is one call, and it
 * STREAMS: `onLine` is handed each line the machine prints while it prints it, which is the difference between a
 * button that shows an update happening and one that spins in silence for four minutes.
 *
 * The machine enforces which of these it will do ("Manage sandboxes" for six, a separate switch for removal), and
 * a refusal arrives as this promise's rejection carrying the machine's own sentence naming the switch to flip. */
export async function manageMachineSandbox(
    hostId: string,
    slug: string,
    op: MachineSandboxOp,
    { hash, onLine }: { hash?: string; onLine?: (line: string) => void } = {},
): Promise<string> {
    const response = await sandboxRequest(`/system/computers/${encodeURIComponent(hostId)}/sandboxes/${encodeURIComponent(slug)}`, {
        method: `POST`,
        headers: { "content-type": `application/json` },
        body: JSON.stringify({ id: hostId, slug, op, ...(hash === undefined ? {} : { hash }) }),
    });
    if (!response.ok || !response.body) {
        throw await sandboxError(response, { method: `POST`, path: `/system/computers/{id}/sandboxes/{slug}` });
    }
    // The terminal frame is the answer. A stream that ends without one means the connection dropped mid-flight,
    // which does NOT mean the operation stopped: it is running on the machine, and the fleet re-read that follows
    // is what tells the truth about it.
    let outcome: string | undefined;
    for await (const line of readIntenticLines(response.body)) {
        if (line[`kind`] === `line` && typeof line[`text`] === `string`) {
            onLine?.(line[`text`]);
            continue;
        }
        if (line[`kind`] === `error`) {
            throw new Error(typeof line[`message`] === `string` ? line[`message`] : `That operation failed on the computer.`);
        }
        if (line[`kind`] === `result` && typeof line[`message`] === `string`) {
            outcome = line[`message`];
        }
    }
    if (outcome === undefined) {
        throw new Error(`Lost contact with that computer while this was running: it may still have finished. Refresh to see where it got to.`);
    }
    return outcome;
}

/* ONE OF THAT COMPUTER'S OWN CLI ACTIONS, RUN FROM A BUTTON, with no terminal and no agent in the middle.
 *
 * The gap it closes: the thing somebody wants ("stop putting these ports on my localhost") is one command on
 * their own machine, that machine is already connected, and the only two ways to reach it were to go and find a
 * terminal or to ask a model, which spends a turn and somebody's judgement on a decision that has none in it.
 *
 * NOT A COMMAND LINE. What travels is a NAME from a closed set and, at most, the sandbox id the row is about;
 * the daemon builds the argv from the name (hosts/machine-commands.ts). The socket underneath also carries
 * `run_command`, so a route that forwarded text typed on this side would be a shell on the user's laptop handed
 * out with a browser session, which is a grant no capability card ever made.
 *
 * NOT A STREAM, unlike manageMachineSandbox above: these are seconds-long calls whose whole answer is the
 * sentence the CLI prints at the end, and a progress pane for that is a shape with nothing to put in it.
 *
 * `ok: false` is a RESULT, not a throw: the machine refusing (its "Run commands" switch is off) or its CLI
 * exiting non-zero is a real answer in the machine's own words, and the caller shows it. Only a machine that
 * could not be reached at all rejects, because then there is nothing to report. */
export async function runMachineCommand(hostId: string, command: MachineCommand, sandboxId?: string): Promise<MachineCommandResult> {
    const path = `/system/computers/${encodeURIComponent(hostId)}/commands/${encodeURIComponent(command)}`;
    const response = await sandboxRequest(path, {
        method: `POST`,
        headers: { "content-type": `application/json` },
        body: JSON.stringify({ id: hostId, command, ...(sandboxId === undefined ? {} : { sandboxId }) }),
    });
    if (!response.ok) {
        throw await sandboxError(response, { method: `POST`, path: `/system/computers/{id}/commands/{command}` });
    }
    return MachineCommandResultSchema.parse(await response.json());
}

/* CUTTING ONE COMPUTER OFF FROM THIS SANDBOX'S DESKTOP SYNC, from the row that describes it.
 *
 * The twin of the hosts revoke, and it arrived late for a reason worth remembering: the only revoke a browser
 * could reach cleared EVERY enrollment, because it lived under a card that treated desktop sync as one property
 * of the sandbox. "I don't use that laptop any more" therefore meant taking everybody else's sync down with it.
 *
 * THE SANDBOX'S OWN DOOR, not the machine's, which is what makes it the right button for the case it exists for:
 * a laptop that is lost, wiped, asleep or simply somebody else's answers nothing, and this needs it to answer
 * nothing. It drops the key from authorized_keys here; the agent over there discovers it on its next poll and
 * tears its own mirroring down. Unpairing a machine you are holding is the other button (`sync-unpair`), which
 * asks the machine to clean up properly and is better whenever the machine is there to ask. */
export async function revokeSyncMachine(machine: string): Promise<void> {
    const response = await sandboxRequest(`/system/authorized-key/${encodeURIComponent(machine)}`, { method: `DELETE` });
    if (!response.ok) {
        throw await sandboxError(response, { method: `DELETE`, path: `/system/authorized-key/{machine}` });
    }
}

/* THE CONNECTED COMPUTER THAT RUNS A GIVEN SANDBOX, when there is one, the fact that turns "paste this command
 * on the machine that runs your sandbox" into a button.
 *
 * Only a connected computer qualifies, and only while it is online: the sync agent never reports containers, so a
 * machine reachable through that door alone cannot be asked to recreate one. Offered rather than assumed, a
 * button that fails when taken is worse than the command it replaced, and this one would fail at the moment
 * somebody's sandbox is already unhappy.
 *
 * Shares the Computers query, so a hub with both this card and that view open asks the machine once, and does
 * NOT poll it: this is a card deciding what kind of control to draw, not a view of the machines. With the tab
 * open the poll is there anyway (same key, same cache); without it, an update card sitting on the Overview stops
 * being a reason to talk to somebody's laptop every ten seconds. */
export function useHostRunning(slug: () => string | undefined): ComputedRef<string | undefined> {
    const { computers } = useComputers({ poll: false });
    return computed(() => {
        const target = slug();
        if (target === undefined || target === ``) {
            return undefined;
        }
        return computers.value.find(
            (computer) =>
                computer.hostId !== undefined && computer.online === true && (computer.report?.sandboxes ?? []).some((box) => box.slug === target),
        )?.hostId;
    });
}

/* How stale a machine's own reading may be before the view stops presenting it as now. The sync agent reports
 * every ~15s and the daemon re-pulls every 10s, so anything past a minute means the machine stopped talking,
 * its lid closed, its agent died, and the rows below it describe a computer that has moved on.
 *
 * The same argument as the sync card's heartbeat: a report shown as current when its machine went quiet an hour
 * ago is precisely the lie that let a lost pairing go unnoticed for days. */
const REPORT_STALE_MS = 60_000;

export const reportStale = (computer: Computer, now: number): boolean =>
    computer.report !== undefined && now - computer.report.capturedAt > REPORT_STALE_MS;

/* The rail's ambient read of the same subject, and deliberately NOT /system/computers.
 *
 * That route asks every connected computer a question over its WebSocket. Behind the Computers tab that is
 * exactly right: someone is looking. Behind the rail chip it would mean this sandbox pokes the user's laptop
 * every few seconds for as long as any page is open, forever, to decide whether to draw a badge.
 *
 * /system/sync costs the daemon nothing, the volunteered reports are already in its memory, and it carries the
 * two facts a badge can act on. So the ambient half is free, and reaching out to a machine stays a thing that
 * happens because a person opened the view that shows it. */
const HEALTH_POLL_MS = 60_000;

export function useSyncHealth(): { stoppedOn: ComputedRef<string[]>; contendedPorts: ComputedRef<number[]> } {
    const { query } = useSandboxQuery({
        queryKey: SYNC_HEALTH.of(),
        queryFn: async () => SyncStatusSchema.parse(await sandboxJson(`/system/sync`)),
        refetchInterval: HEALTH_POLL_MS,
    });
    const machines = computed(() => query.data.value?.machines ?? []);
    return {
        // A machine whose watcher died: its folder has stopped syncing and its ports have stopped being renewed,
        // while every other signal in the product still reads healthy. The exact failure that used to take days
        // to notice.
        stoppedOn: computed(() => machines.value.filter((report) => !report.watcher.running).map((report) => report.hostname)),
        // A port the sandbox serves that never reached the user's localhost because another paired sandbox holds
        // the number. "My dev server isn't on localhost" is otherwise a hunt for a process that does not exist.
        contendedPorts: computed(() => [
            ...new Set(machines.value.flatMap((report) => report.ports.filter((port) => port.state !== `mirrored`).map((port) => port.port))),
        ]),
    };
}
