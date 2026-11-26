import { serialLock } from "@intentic/base/async";
import { hostRunningSandbox } from "@intentic/sandbox-contract/schemas/devices";
import { isOpenNeed, type Need } from "@intentic/sandbox-contract/schemas/needs";
import type { WslMemory, WslMemoryFit, WslMemoryNeed } from "@intentic/sandbox-contract/schemas/wsl-memory";
import type { Logger } from "pino";
import type { Services } from "../../composition.js";
import type { Needs } from "../../needs/needs.js";
import { refreshFactsBeside } from "../device-facts-refresh.js";
import { heldHostDevices } from "../device-reports.js";
import { type PowerDoor, powerDoorOf } from "../power/host-power.js";
import { ownSlug } from "../self-host.js";

/* A WSL2 VM TOO BIG FOR THE PC THIS SANDBOX RUNS ON (2026-11-26). rog gives its VM `memory=22GB` of 31.4 GiB, and
   Windows sat under its 3.1 GiB low line for hours while the VM held 16.6 GiB. The PC's own agent works out a size that
   fits (machine `environments/wsl-memory-fit.ts`) and says it in its facts (`DeviceFacts.wslMemory`); the daemon puts
   it to the owner on a `wsl-memory` card (needs/kinds/wsl-memory-need.ts), whose yes writes it into `.wslconfig`.
   Nothing here restarts WSL: that restarts every sandbox on the PC, this one included, and is the owner's to do.

   No booking raises it: it is about the PC, not about any piece of work. It goes up in the conversation a person just
   spoke in, the next time one does while the finding stands, read from the facts already held (a reading of them is
   asked for beside, at most every two minutes, never waited on). Said once: an open card for that PC in any
   conversation is enough, and one declined in the last 30 days stays down unless the PC got worse since. Read from the
   needs already stored, so nothing new is kept to remember it. */

// How long a declined card keeps the same finding from raising another.
export const WSL_MEMORY_DECLINE_QUIET_MS = 30 * 24 * 3_600_000;
// Worse, which raises a card a person declined: Windows short in this much more of the readings than when they said no.
const WORSE_SHARE = 0.15;

/** Whether `now` is worse than `before`, the finding a person declined: a smaller size fits, or Windows is short more often. Pure. */
export const wslMemoryWorse = (before: WslMemoryFit, now: WslMemoryFit): boolean =>
    now.proposedGb < before.proposedGb || now.underLowShare >= before.underLowShare + WORSE_SHARE;

/**
 * Why no card goes up for `fit` on `device`, or undefined when one should: a card for that PC is already open in any
 * conversation, or a person declined one in the last 30 days and the PC is no worse than it was then. Pure.
 */
export const wslMemoryCardSuppressed = (needs: readonly Need[], device: string, fit: WslMemoryFit, now: number): string | undefined => {
    const cards = needs.flatMap((need): { readonly need: Need; readonly subject: WslMemoryNeed }[] =>
        need.subject.kind === "wsl-memory" && need.subject.device === device ? [{ need, subject: need.subject }] : [],
    );
    const open = cards.find((card) => isOpenNeed(card.need));
    if (open !== undefined) {
        return `${open.need.id} is already open for it, in conversation ${open.need.conversationId}`;
    }
    const declined = cards.find(
        ({ need, subject }) => need.status === "declined" && now - need.updatedAt < WSL_MEMORY_DECLINE_QUIET_MS && !wslMemoryWorse(subject.fit, fit),
    );
    return declined === undefined ? undefined : `a person declined ${declined.need.id} within 30 days, and the PC is no worse since`;
};

/** The card's title: the PC, as the owner calls it, and the size that fits. Pure. */
export const wslMemoryTitle = (name: string, fit: Pick<WslMemoryFit, "proposedGb">): string => `${name}'s WSL VM is too big for it: memory=${fit.proposedGb}GB would fit`;

// What the check reads and raises through, so it runs over fakes in a test.
export interface WslMemoryCheckDeps {
    readonly now: () => number;
    // The PC this sandbox runs on, by the connection holding its own settings (Windows' own side); undefined on a runner,
    // in the cloud, and when nothing has been read yet.
    readonly selfHost: () => Promise<PowerDoor | undefined>;
    // What its facts say of the VM as held now, never a pull.
    readonly memory: (device: string) => WslMemory | undefined;
    readonly needs: Pick<Needs, "list" | "observe">;
    readonly logger: Pick<Logger, "info">;
}

/** Raises a wsl-memory card in `conversationId` when the PC this sandbox runs on says its VM is too big; answers it, or undefined when none went up. */
export const raiseWslMemoryCard = async (deps: WslMemoryCheckDeps, conversationId: string): Promise<Need | undefined> => {
    const host = await deps.selfHost();
    if (host === undefined) {
        return undefined;
    }
    const memory = deps.memory(host.device);
    const fit = memory?.fit;
    if (memory === undefined || fit === undefined) {
        return undefined;
    }
    const now = deps.now();
    const suppressed = wslMemoryCardSuppressed(await deps.needs.list({}), host.device, fit, now);
    if (suppressed !== undefined) {
        deps.logger.info({ conversationId, device: host.device, proposedGb: fit.proposedGb, why: suppressed }, "wsl memory: the VM is too big for its PC; no new card");
        return undefined;
    }
    const need = await deps.needs.observe(conversationId, { kind: "wsl-memory", device: host.device, configPath: memory.configPath, fit }, wslMemoryTitle(host.name, fit));
    deps.logger.info({ conversationId, device: host.device, proposedGb: fit.proposedGb, configuredGb: fit.configuredGb, need: need.id }, "wsl memory: the VM is too big for its PC; card raised");
    return need;
};

// The check over the daemon's own services: the device list and the hub as they are held, and the needs service.
const wslMemoryCheckDeps = (services: Services): WslMemoryCheckDeps => ({
    now: Date.now,
    selfHost: async () => {
        const devices = await heldHostDevices(services);
        const running = hostRunningSandbox(devices, ownSlug(services));
        const door = running === undefined ? undefined : powerDoorOf(devices, running);
        // The facts the next person's turn reads: asked for beside, at most every two minutes, never waited on.
        if (door !== undefined) {
            refreshFactsBeside(services, door.device);
        }
        return door;
    },
    memory: (device) => services.hostHub.state(device).facts?.wslMemory,
    needs: services.needs,
    logger: services.logger,
});

// One check at a time in this daemon, so two people speaking in the same breath find the first one's card.
const oneAtATime = serialLock();

/**
 * After a person's turn started in `conversationId`: raises a wsl-memory card there when the PC this sandbox runs on says
 * its VM is too big for it. Never throws and never holds the turn: callers `void` it, and a failure is a warning in the log.
 */
export const checkWslMemoryFor = (services: Services, conversationId: string): Promise<void> =>
    oneAtATime(() => raiseWslMemoryCard(wslMemoryCheckDeps(services), conversationId))
        .then(() => undefined)
        .catch((error: Error) => services.logger.warn({ err: error, conversationId }, "wsl memory: could not check the PC this sandbox runs on"));
