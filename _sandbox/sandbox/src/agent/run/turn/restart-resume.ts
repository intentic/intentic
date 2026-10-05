import { join } from "node:path";
import type { DeviceFlowLine } from "@intentic/sandbox-contract";
import { z } from "zod";
import { defineDocument } from "../../../store/evolution/documents.js";
import { openDocument } from "../../../store/open-document.js";

// A RESTART THE OWNER STARTED AND ASKED TO PICK UP AFTER. With autoResumeOnRestart off, a turn a restart cuts is recorded
// as interrupted and waits for a message, and after a rebuild the owner started with four agents mid-turn they sat
// "Interrupted" for half an hour. So the rebuild dialog can say "continue them afterwards", and a rebuild the sandbox
// starts by itself once its agents are idle always does: the ask is written before the swap is relayed to the device
// and read once by the next boot, which resumes what the restart cut as autoResumeOnRestart would, that one time.
// On the history volume beside the update markers: it is about this machine's next boot, never carried in a bundle.
const RestartResumeSchema = z.object({
    // When the ask was made; absent once the boot it was for has read it, or the swap ended without a restart.
    askedAt: z.number().optional(),
});
export const restartResumeDocument = defineDocument({ root: "history", path: "restart-resume.json", schema: RestartResumeSchema });

// How long an ask stands: a rebuild builds for many minutes before its restart, and one that died before restarting
// must not make an unrelated restart hours later resume whatever it cuts.
const ASK_STANDS_MS = 2 * 60 * 60_000;

export interface RestartResume {
    // The next restart's cut turns are to run again.
    readonly ask: (at: number) => Promise<void>;
    // The swap ended without restarting this sandbox, so no restart is coming for the ask to be about.
    readonly withdraw: () => Promise<void>;
    // Whether the restart this boot follows was asked to resume, spending the ask either way.
    readonly take: (now: number) => Promise<boolean>;
    // When the standing ask was made, without spending it; undefined when none stands. Optional for a stand-in.
    readonly askedAt?: () => Promise<number | undefined>;
}

// Opened wherever it is needed: every handle on the path shares its write queue. A restart asked for WITHOUT picking up
// after withdraws an ask still standing from an earlier one whose answer nobody stayed to relay, so the owner's
// unticked box is what this restart does.
export const fileRestartResume = (historyRoot: string): RestartResume => {
    const file = openDocument(restartResumeDocument, join(historyRoot, restartResumeDocument.path), { fallback: () => ({}) });
    const withdraw = async (): Promise<void> => {
        await file.update((current) => (current.askedAt === undefined ? current : {}));
    };
    return {
        ask: async (at) => {
            await file.update(() => ({ askedAt: at }));
        },
        withdraw,
        askedAt: async () => (await file.read()).askedAt,
        take: async (now) => {
            const { askedAt } = await file.read();
            if (askedAt === undefined) {
                return false;
            }
            await withdraw();
            return now - askedAt >= 0 && now - askedAt <= ASK_STANDS_MS;
        },
    };
};

// Relays the device's lines for a swap of this sandbox the owner asked to pick up after, the ask made first. A terminal
// frame this process lives to relay is the machine answering in words instead of restarting it (a refusal, or nothing
// to do), and so is a failure to reach it before it said anything: the ask goes with either. A stream that just stops is
// the cutover, or a page that walked away while the machine carries on, and so is a link that drops once the machine
// has begun (its build goes on without the relay): the ask stands for the boot after.
export async function* askedRestart(resume: RestartResume, at: number, lines: AsyncIterable<DeviceFlowLine>): AsyncGenerator<DeviceFlowLine> {
    await resume.ask(at);
    let begun = false;
    try {
        for await (const line of lines) {
            begun = true;
            if (line.kind !== "line") {
                await resume.withdraw();
            }
            yield line;
        }
    } catch (error) {
        if (!begun) {
            await resume.withdraw();
        }
        throw error;
    }
}
