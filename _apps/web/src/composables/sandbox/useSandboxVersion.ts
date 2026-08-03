import { InfoSchema } from "@intentic/sandbox-contract";
import { computed } from "vue";
import { sandboxJson } from "./sandboxClient";
import { sandboxKey } from "./useSandbox";
import { useSandboxQuery } from "./useSandboxQuery";
import { useEnvironment } from "./useEnvironment";

/* The sandbox daemon's self-report (/info): its running `version` and — once the daemon has checked GitHub —
 * the `latest` published release plus `updateAvailable`. ONE shared query (vue-query dedupes on the key) feeds
 * both the /sandbox hub card and the chip's attention list, mirroring useEnvironment. The update itself runs on
 * the host (the sandbox has no Docker socket) — a button in the desktop app, a token-free one-liner in a
 * browser, both from HostRecreate.vue and both the same shape as the environment rebuild minus the hash (the
 * :stable base is trusted by its tag).
 *
 * `updateAvailable` is the whole of it: there is no per-version "don't tell me again" here, because there is
 * nothing left to silence. The fact wears a badge on the sandbox chip now, and a badge already goes quiet on
 * its own the moment it stops being true. */

const INFO_KEY = sandboxKey(`info`);

export function useSandboxVersion() {
    const { serverManaged, state: envState } = useEnvironment();

    const { query } = useSandboxQuery({
        queryKey: INFO_KEY,
        queryFn: async () => InfoSchema.parse(await sandboxJson(`/info`)),
    });
    const info = computed(() => query.data.value);
    const installed = computed(() => info.value?.version);
    const latest = computed(() => info.value?.latest);
    const updateAvailable = computed(() => info.value?.updateAvailable === true);

    /* Which agent runtimes can serve a turn right now, keyed by AgentCapabilities.runtime — the daemon probes
     * this off the turn path so a picker can say a subscription is missing BEFORE the user writes a prompt.
     *
     * `unknown` and absent both mean "not verified", and both are deliberately NOT rendered as a problem: the
     * probe failing must never grey out a provider that in fact works. Only an explicit `unavailable` is worth
     * showing, and it arrives with the sentence naming what to connect. */
    const runtimeIssue = (runtime: string): string | undefined => {
        const health = info.value?.runtimes?.[runtime];
        return health?.state === `unavailable` ? (health.detail ?? `This runtime can't serve a turn right now.`) : undefined;
    };

    // Which sandbox a recreate would name — the container comes from /environment (the daemon returns it even
    // without an overlay). HostRecreate turns this into a button in the desktop app and a command elsewhere.
    const slug = computed(() => envState.value?.container?.replace(/^intentic-sandbox-/, ``));

    return { info, installed, latest, updateAvailable, runtimeIssue, serverManaged, slug };
}
