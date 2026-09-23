import { resetSandboxScope } from "@intentic/extension-api";
import { afterEach, describe, expect, it, mock } from "bun:test";
import type { SandboxMetrics } from "@intentic/sandbox-contract";
import { type ComputedRef, shallowRef } from "vue";
import type { SandboxRpc } from "../../sandbox/client/sandboxRpc";
import { fakeSandboxRpc } from "../../../testing/sandboxRpcFake";

/* Whether the board asks at all is the whole promise of the preference: off must mean no request, so the daemon (which
 * measures only when asked) measures nothing. The query layer is stood in for, so what is pinned is what this module
 * hands it: when it may run, how often, and what it asks for. */

interface CapturedOptions {
    readonly queryKey: ComputedRef<unknown[]>;
    readonly enabled: ComputedRef<boolean>;
    readonly refetchInterval: (query: { readonly state: { readonly status: string } }) => number | false;
    readonly queryFn: () => Promise<SandboxMetrics>;
}

const captured: { options?: CapturedOptions } = {};
const data = shallowRef<SandboxMetrics | undefined>(undefined);
const reading: SandboxMetrics = {
    at: 1,
    sandbox: { cores: 4, memoryBytes: 1, memoryLimitBytes: 2, loadAverage: [0, 0, 0], processes: 3 },
    daemon: { rssBytes: 1, heapUsedBytes: 1 },
    sessions: {},
    roles: {},
};
const measure = mock<SandboxRpc[`system`][`metrics`]>(async () => reading);

mock.module("../../sandbox/client/useSandboxQuery", () => ({
    useSandboxQuery: (options: CapturedOptions) => {
        captured.options = options;
        return { query: { data }, error: { value: undefined } };
    },
}));
mock.module("../../sandbox/client/sandboxRpc", () => ({ sandboxRpc: fakeSandboxRpc({ system: { metrics: measure } }) }));

const { heaviestRoles, LIVE_METRICS_POLL_MS, showLiveMetrics, useLiveMetrics } = await import("./liveMetrics");
const { setDaemonRoutes } = await import("../../sandbox/overview/useDaemonRoutes");
const { activeSandboxId } = await import("../../sandbox/overview/activeSandbox");
const { UNPERSISTED } = await import("../../../lib/queryPersistence");

const optionsOf = (): CapturedOptions => {
    if (captured.options === undefined) {
        throw new Error(`useLiveMetrics never reached the query layer`);
    }
    return captured.options;
};

afterEach(() => {
    showLiveMetrics.value = false;
    data.value = undefined;
    resetSandboxScope();
    measure.mockClear();
});

describe("useLiveMetrics", () => {
    it("never asks while the preference is off, and shows nothing it already had", () => {
        data.value = reading;
        const metrics = useLiveMetrics();
        expect(optionsOf().enabled.value).toBe(false);
        expect(metrics.value).toBeUndefined();
    });

    it("once on, asks every three seconds, and stops asking after a refusal", () => {
        showLiveMetrics.value = true;
        data.value = reading;
        const metrics = useLiveMetrics();
        expect(optionsOf().enabled.value).toBe(true);
        expect(metrics.value).toBe(reading);
        expect(LIVE_METRICS_POLL_MS).toBe(3_000);
        expect(optionsOf().refetchInterval({ state: { status: `success` } })).toBe(3_000);
        expect(optionsOf().refetchInterval({ state: { status: `error` } })).toBe(false);
    });

    it("turning it off stops the asking at once, without leaving the board", () => {
        showLiveMetrics.value = true;
        useLiveMetrics();
        expect(optionsOf().enabled.value).toBe(true);
        showLiveMetrics.value = false;
        expect(optionsOf().enabled.value).toBe(false);
    });

    it("does not ask a daemon that says it has no such route", () => {
        showLiveMetrics.value = true;
        setDaemonRoutes([`system.info`]);
        useLiveMetrics();
        expect(optionsOf().enabled.value).toBe(false);
        setDaemonRoutes([`system.info`, `system.metrics`]);
        expect(optionsOf().enabled.value).toBe(true);
    });

    it("reads the daemon's system.metrics, for the active sandbox", async () => {
        showLiveMetrics.value = true;
        useLiveMetrics();
        expect(await optionsOf().queryFn()).toEqual(reading);
        expect(measure.mock.calls).toEqual([[undefined, { context: {} }]]);
        // Kept in memory alone: a reading is superseded every few seconds, so a disk copy would only ever be stale.
        expect(optionsOf().queryKey.value).toEqual([`system.metrics`, UNPERSISTED, activeSandboxId]);
    });
});

describe("heaviestRoles", () => {
    it("names the kinds holding the most memory, heaviest first, and never one holding none", () => {
        expect(
            heaviestRoles(
                {
                    browser: { processes: 20, rssBytes: 300 },
                    toolchain: { processes: 4, rssBytes: 900 },
                    other: { processes: 2, rssBytes: 0 },
                    git: { processes: 1, rssBytes: 10 },
                    searchEngine: { processes: 1, rssBytes: 400 },
                },
                3,
            ),
        ).toEqual([
            { role: `toolchain`, rssBytes: 900 },
            { role: `searchEngine`, rssBytes: 400 },
            { role: `browser`, rssBytes: 300 },
        ]);
    });
});
