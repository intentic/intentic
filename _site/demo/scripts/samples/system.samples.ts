import { STATE_DIR } from "@intentic/constants";
import type { GroupSamples } from "./context.ts";

export const systemSamples: GroupSamples<`system`> = ({ host }) => ({
    events: { clientId: `smoke` },
    info: undefined,
    session: undefined,
    presence: { clientId: `smoke`, idle: false },
    usage: undefined,
    metrics: undefined,
    terminals: undefined,
    browsers: undefined,
    devices: undefined,
    egressOwnerKeys: undefined,
    runDeviceAgentFlow: { id: host, op: `restart` },
    // A log tail and a pause: the two that leave the fixture's containers and pairings as they were.
    manageDeviceSandbox: { id: host, slug: `docs-site`, op: `logs` },
    runDeviceCommand: { id: host, command: `sync-pause`, sandboxId: `billing-api` },
    openBrowser: { url: `https://example.com` },
    // A tab of the checkout agent's recorded browser closed, and the finished signup session put away.
    closeBrowser: { name: `browser-flaky-signup` },
    closeBrowserPage: { name: `browser-checkout-stripe`, pageId: `page_docs` },
    desktop: undefined,
    subagents: undefined,
    storage: undefined,
    scanStorage: undefined,
    cancelStorageScan: undefined,
    cleanStorage: { category: `logs` },
    // Leaves the switch on and nothing skipped, as it was.
    autoUpdate: { enabled: true },
    skipUpdate: { version: null },
    terminalScrollback: { name: `agent-checkout-stripe`, lines: `200` },
    // The settings file's misspelt key renamed to what it meant; the session closed last.
    manifestProblems: undefined,
    repairManifest: { path: `${STATE_DIR}/config/settings.json`, key: `autoLnad`, to: `autoLand` },
    killTerminal: { name: `agent-checkout-stripe` },
});
