import type { Info } from "@intentic/sandbox-contract/schemas/system";
import { closeOwnBrowser, closeOwnTab, OWN_SESSION, openOwnBrowser, ownSession } from "../../browser";
import { DESK_SANDBOX_NAME } from "../../fixture/desk";
import { demoCommandSaid, demoDevices, demoEgressOwnerKeys, switchDemoPairings } from "../../fixture/devices";
import { inProcessSubagents } from "../../fixture/fleet";
import { demoMetrics } from "../../fixture/metrics";
import { demoStorageCancel, demoStorageClean, demoStorageReport, demoStorageScan } from "../../fixture/storage";
import { demoQuiet, deskEdition } from "../../mode";
import { agentFlow, sandboxFlow } from "./deviceFlows";
import { events } from "../events";
import { manifestProblems, repairManifest } from "./settingsManifests";
import { closeRecordedBrowser, closeRecordedPage, recordedBrowsers } from "./recordedBrowsers";
import { roster, STARTED_AT } from "../board/roster";
import { killTerminal, terminalScrollback, terminalsList } from "./terminals";
import type { Doors } from "../doors";
import { desktopState } from "../../desktop";
import { configureAutoUpdate, skipRelease, withUpdateState } from "./updates";

const info: Info = { name: deskEdition ? DESK_SANDBOX_NAME : `acme-shop`, version: `demo`, latest: `demo`, updateAvailable: false };

export const systemDoors = {
    events,
    // The fixture's identity, with the update state the owner's presses left (daemon/updates.ts).
    info: () => withUpdateState(info),
    session: () => ({ token: `demo-session`, expiresAt: Date.now() + 30 * 24 * 3_600_000, email: `ada@acme.dev` }),
    presence: () => ({ ok: true }),
    usage: () => ({ accounts: [] }),
    // Asked only while geek metrics are on (the status bar's gauges); it drifts per request, so the polling is visible.
    metrics: () => demoMetrics(Date.now(), roster.agents),
    // The Overview's Disk card: a scan already on hand, a rescan on request, and a clean that frees its category.
    storage: () => demoStorageReport(),
    scanStorage: () => demoStorageScan(),
    cancelStorageScan: () => demoStorageCancel(),
    cleanStorage: ({ category }) => demoStorageClean(category),
    // The sessions the sandbox holds, with whatever other stores' work started (daemon/terminals.ts).
    terminals: terminalsList,
    killTerminal,
    terminalScrollback,
    // Settings files with a key nobody reads, and the button that takes one out (daemon/manifests.ts).
    manifestProblems,
    repairManifest,
    // One still-driven browser session and one already closed, rendered as history, not a broken stream.
    // Quiet, the agent has put its browser down: the session is history, so the status bar has no open one to count.
    browsers: () => {
        const now = Date.now();
        const mine = ownSession(now);
        return {
            sessions: [
                ...(mine === undefined ? [] : [mine]),
                ...recordedBrowsers(now).map((session) =>
                    demoQuiet() && session.running ? { ...session, running: false, finishedAt: session.activityAt } : session,
                ),
            ],
        };
    },
    // The visitor's own window opens for real (browser.ts): a tab per call, its picture drawn from the address.
    openBrowser: ({ url }) => openOwnBrowser(url),
    // The owner's own computers. Without this the Devices tab could only say it had nothing to show, so nothing
    // under a paired folder — the sync switches, and the two answers to a conflict — was ever drawn.
    devices: () => ({ devices: demoDevices(Date.now()) }),
    // What a loosening of a sandbox's network fence is signed over, and the exceptions offered for it (fixture/devices.ts).
    egressOwnerKeys: () => demoEgressOwnerKeys(),
    // The agent's own two verbs, streamed as the daemon streams them: progress lines, then the machine's sentence.
    // Each environment of a PC answers for itself, which is what a machine-wide update walks through — without this
    // the only state that page could show was the refusal of a route nobody serves.
    runDeviceAgentFlow: ({ id, op }) => agentFlow(id, op),
    // The container verbs and the unpair a removal ends with, answered the way a machine does, so a batch over
    // several rows can be pressed and watched rather than refused as a route nobody serves.
    manageDeviceSandbox: ({ slug, op, setupCode }) => sandboxFlow(slug, op, setupCode),
    runDeviceCommand: ({ id, command, sandboxId }) => {
        switchDemoPairings(id, command, sandboxId);
        return { ok: true, refused: false, message: demoCommandSaid(command, sandboxId) };
    },
    // The visitor's own window closes for real (browser.ts); a recorded agent's leaves the list (recordedBrowsers.ts).
    closeBrowser: ({ name }) => {
        if (name !== OWN_SESSION) {
            return closeRecordedBrowser(name);
        }
        closeOwnBrowser();
        return { ok: true };
    },
    closeBrowserPage: ({ name, pageId }) => {
        if (name !== OWN_SESSION) {
            return closeRecordedPage(name, pageId);
        }
        closeOwnTab(pageId);
        return { ok: true };
    },
    // The sandbox's own desktop, drawn and streamed in the page (desktop.ts): up, with its windows.
    desktop: () => desktopState(),
    subagents: () => ({ sessions: deskEdition || demoQuiet() ? [] : inProcessSubagents(STARTED_AT) }),
    // The owner's say over taking updates by itself, and a release not to offer again (daemon/updates.ts).
    autoUpdate: (input) => configureAutoUpdate(input),
    skipUpdate: ({ version }) => skipRelease(version),
} satisfies Doors<`system`>;
