import { InfoSchema } from "@intentic/sandbox-contract";
import { computed } from "vue";
import { bashCommand } from "../../environments/scriptCommand";
import { sandboxJson } from "./sandboxClient";
import { sandboxKey } from "./useSandbox";
import { useSandboxQuery } from "./useSandboxQuery";
import { useEnvironment } from "./useEnvironment";

/* The sandbox daemon's self-report (/info): its running `version` and — once the daemon has checked GitHub —
 * the `latest` published release plus `updateAvailable`. ONE shared query (vue-query dedupes on the key) feeds
 * both the /sandbox hub card and the chip's attention list, mirroring useEnvironment. The update itself runs on
 * the host (the sandbox has no Docker socket) via a token-free one-liner — the same shape as the environment
 * rebuild command, minus the hash (the :stable base is trusted by its tag).
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

    // The host-run update one-liner: slug only (no hash, no token). The container name comes from /environment
    // (the daemon returns it even without an overlay). Empty until both the container and an update are known.
    const slug = computed(() => envState.value?.container?.replace(/^intentic-sandbox-/, ``));
    const updateCommand = computed(() => (slug.value !== undefined && updateAvailable.value ? bashCommand(`update`, ``, slug.value) : ``));

    return { info, installed, latest, updateAvailable, serverManaged, updateCommand };
}
