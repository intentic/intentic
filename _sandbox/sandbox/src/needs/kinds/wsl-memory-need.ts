import { errorMessage } from "@intentic/base/errors";
import type { DeviceAgentFlow, DeviceFlowLine } from "@intentic/sandbox-contract/schemas/devices";
import { type DeviceFacts, DEVICE_FEATURE_WSL_MEMORY, deviceSupports, parseHostConnection } from "@intentic/sandbox-contract/schemas/hosts";
import type { Need, NeedSubject } from "@intentic/sandbox-contract/schemas/needs";
import type { WslMemoryNeed } from "@intentic/sandbox-contract/schemas/wsl-memory";
import type { Answered, Met, NeedKindHandler, Resolved } from "../need-kinds.js";
import { changedOn } from "./host-power-need.js";

/* The WSL2 VM of the PC this sandbox runs on is too big for it (2026-11-26, hosts/wsl-memory/wsl-memory.ts). The card
   says what the PC's agent measured and the `memory=` it proposes, and that nothing changes until WSL restarts, which
   restarts every sandbox on that PC, this one included. The owner's yes runs the PC's `wsl-memory` op through the same
   door the power card's yes takes, which writes that one line of `.wslconfig` with the file as it was kept beside it;
   restarting WSL stays theirs. Their no keeps it down for 30 days unless the PC gets worse (wsl-memory.ts).

   There is no "apply and restart when quiet": nothing in Intentic restarts a PC's WSL, at a quiet time or any other
   (the sandbox's own update-when-quiet restarts that one sandbox, never the VM all of them run in). The daemon raises
   this card itself; no agent asks for it, and none hears how it ended (`tellsAgent`): it is the PC's, not the work's. */

export interface WslMemoryNeedDeps {
    // The PC's facts as the hub holds them now, never a pull.
    readonly facts: (device: string) => DeviceFacts | undefined;
    readonly online: (device: string) => boolean;
    // The agent op, run the way the Devices view's agent buttons run it (hosts/device-reports.ts `runDeviceAgentFlow`).
    readonly runAgentFlow: (device: string, flow: DeviceAgentFlow) => AsyncIterable<DeviceFlowLine>;
    // Asks the PC to describe itself again within a short deadline; it keeps the last answer when it cannot.
    readonly refresh: (device: string) => Promise<void>;
}

const deviceName = (device: string): string => parseHostConnection(device).card;

/** Whether the PC's `.wslconfig`, as its facts held now say it, already gives the VM no more than the card proposes. Pure. */
export const wslMemoryApplied = (subject: Pick<WslMemoryNeed, "fit">, facts: DeviceFacts | undefined): boolean => {
    const configured = facts?.wslMemory?.configuredGb;
    return configured !== undefined && configured <= subject.fit.proposedGb;
};

// The sentence a met card keeps: what was written, and the restart still to come.
const writtenOn = (name: string, said: string): string =>
    `${said} The VM keeps its old size until WSL restarts on ${name} (wsl --shutdown, or a reboot), which restarts every sandbox there, this one included.`;

export const wslMemoryNeed = (deps: WslMemoryNeedDeps): NeedKindHandler => {
    const subjectOf = (need: Need): WslMemoryNeed | undefined => (need.subject.kind === "wsl-memory" ? need.subject : undefined);

    // The op itself, its frames read through, as the power card reads its own (host-power-need.ts).
    const run = async (
        subject: WslMemoryNeed,
    ): Promise<{ readonly refused: string } | { readonly lines: readonly string[]; readonly result: string | undefined }> => {
        const lines: string[] = [];
        let result: string | undefined;
        try {
            for await (const frame of deps.runAgentFlow(subject.device, { op: "wsl-memory", memoryGb: subject.fit.proposedGb })) {
                if (frame.kind === "error") {
                    return { refused: frame.message };
                }
                if (frame.kind === "line") {
                    lines.push(frame.text);
                } else {
                    result = frame.message;
                }
            }
        } catch (error) {
            return { refused: errorMessage(error) };
        }
        return { lines, result };
    };

    const approve = async (subject: WslMemoryNeed): Promise<Answered> => {
        const name = deviceName(subject.device);
        if (!deps.online(subject.device)) {
            return { refused: `${name} is not connected right now, so nothing can change its .wslconfig: press again once it is back.` };
        }
        if (!deviceSupports(deps.facts(subject.device), DEVICE_FEATURE_WSL_MEMORY)) {
            return { refused: `${name}'s agent is older than this: update it from the Devices view, then press again.` };
        }
        const ran = await run(subject);
        if ("refused" in ran) {
            return { refused: ran.refused };
        }
        // allow(silent-catch): a refresh that times out leaves the last facts, which the check below reads as they are
        await deps.refresh(subject.device).catch(() => undefined);
        if (ran.result === undefined && !wslMemoryApplied(subject, deps.facts(subject.device))) {
            return { refused: `${name} stopped answering before it said .wslconfig was written: press again once it is back.` };
        }
        return { status: "met", result: writtenOn(name, changedOn(name, ran.lines, ran.result)), use: [] };
    };

    return {
        resolve: async (): Promise<Resolved> => ({
            kind: "refused",
            code: "invalid",
            message: "A WSL memory card is raised by the sandbox itself when the PC's VM is too big for it, never asked for.",
        }),
        // Met when the PC's .wslconfig, as already held, gives the VM no more than proposed: the owner set it by hand, or
        // from another card.
        check: async (need): Promise<Met | undefined> => {
            const subject = subjectOf(need);
            if (subject === undefined || !wslMemoryApplied(subject, deps.facts(subject.device))) {
                return undefined;
            }
            const name = deviceName(subject.device);
            return { result: writtenOn(name, `${name}'s .wslconfig gives the VM memory=${deps.facts(subject.device)?.wslMemory?.configuredGb ?? subject.fit.proposedGb}GB now.`), use: [] };
        },
        answer: async (need, answer) => {
            const subject = subjectOf(need);
            if (subject === undefined || answer.kind !== "approve") {
                return { refused: "A WSL memory card is answered by approving the size, or declined." };
            }
            return approve(subject);
        },
        // The floor of the door that runs agent ops from the Devices view: a maintainer, signed in, for a yes and for a no,
        // since a no keeps the card down for 30 days.
        mayAnswer: (_need, by) =>
            by.maintainer === true ? undefined : "Only a sandbox maintainer, signed in, can change a connected PC's .wslconfig or dismiss this.",
        nextTurn: () => false,
        // One card per PC.
        key: (subject: NeedSubject) => (subject.kind === "wsl-memory" ? subject.device : ""),
        tellsAgent: false,
    };
};
