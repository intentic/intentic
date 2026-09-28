import type { DeviceFacts, LoopbackCatch, LoopbackCatchEvent, WebExtFacts } from "@intentic/sandbox-contract";
import type { Services } from "../../../composition.js";
import type { CatchingHub } from "./loopback-bridge.js";

// The one fake of a peer that catches a sign-in's loopback landing (loopback-bridge.ts), for every suite that signs in
// with one watching. It records what it was asked to watch and streams whatever the test pushes, ending when the bridge
// aborts it, exactly as a device agent's stream does over the socket. Not part of the build.

export interface FakeCatcher {
    readonly asked: LoopbackCatch[];
    readonly aborted: () => boolean;
    readonly push: (event: LoopbackCatchEvent) => void;
    readonly catchLoopback: (spec: LoopbackCatch, options: { readonly signal: AbortSignal }) => Promise<AsyncIterable<LoopbackCatchEvent>>;
}

export const fakeCatcher = (): FakeCatcher => {
    const asked: LoopbackCatch[] = [];
    const queue: LoopbackCatchEvent[] = [];
    let wake: (() => void) | undefined;
    let signal: AbortSignal | undefined;
    const nudge = (): void => {
        const resume = wake;
        wake = undefined;
        resume?.();
    };
    async function* stream(): AsyncGenerator<LoopbackCatchEvent> {
        for (;;) {
            const next = queue.shift();
            if (next !== undefined) {
                yield next;
                continue;
            }
            if (signal?.aborted === true) {
                return;
            }
            await new Promise<void>((resolve) => (wake = resolve));
        }
    }
    return {
        asked,
        aborted: () => signal?.aborted === true,
        push: (event) => {
            queue.push(event);
            nudge();
        },
        catchLoopback: async (spec, options) => {
            asked.push(spec);
            signal = options.signal;
            signal.addEventListener("abort", nudge, { once: true });
            return stream();
        },
    };
};

// A device agent new enough to catch, and a browser allowed to.
export const CATCHING_DEVICE: DeviceFacts = { os: "Windows 11", arch: "x64", shell: "pwsh", home: "C:\\Users\\me", roots: [], features: ["loopback-catch"] };
export const CATCHING_BROWSER: WebExtFacts = { browser: "Brave 154 on Windows", tabs: 3, grants: [], paused: false, features: ["loopback-catch"] };

export type FakePeers<Facts> = Record<string, { readonly facts: Facts | undefined; readonly catcher: FakeCatcher }>;

export const catchingHub = <Facts>(peers: FakePeers<Facts>): CatchingHub<Facts> => ({
    connected: () => Object.keys(peers),
    state: (id) => {
        const facts = peers[id]?.facts;
        return facts === undefined ? {} : { facts };
    },
    client: (id) => peers[id]?.catcher,
});

// The same fakes, for a suite whose seam is typed by the whole daemon (a door's deps, the route harness) rather than
// by what the bridge reads.
export const catchingServicesHubs = (
    devices: FakePeers<DeviceFacts>,
    browsers: FakePeers<WebExtFacts> = {},
): Pick<Services, "hostHub" | "webextHub"> => ({
    // SAFETY: nothing a sign-in reaches reads a hub past `connected`, `state` and `client(id).catchLoopback`, which is
    // the whole of CatchingHub (loopback-bridge.ts), and the daemon's hubs are that and more.
    hostHub: catchingHub(devices) as Services["hostHub"],
    // SAFETY: as above, for the browsers' door.
    webextHub: catchingHub(browsers) as Services["webextHub"],
});
