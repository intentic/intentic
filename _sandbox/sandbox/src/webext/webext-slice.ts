import type { Capability } from "@intentic/sandbox-contract";
import type { OwnBrowserReach, WebExtHub, WebExtStore } from "./webext-peer.js";

// The owner's browser extension: its door, hub and reach.
export interface WebextSlice {
    readonly webexts: WebExtStore;
    readonly webextHub: WebExtHub;
    // Which of the owner's own browsers a turn may work in, and what each of them is, for the same reason hostReach
    // exists: the prompt names the browser in front of the person without the agent importing the webext subsystem.
    readonly webextReach: (granted: readonly Capability[]) => Promise<OwnBrowserReach | undefined>;
}
