import { InfoSchema } from "@intentic/sandbox-contract";
import { computed, ref, watch } from "vue";
import { bashCommand } from "../../environments/scriptCommand";
import { sandboxJson } from "./sandboxClient";
import { sandboxKey, useSandbox } from "./useSandbox";
import { useSandboxQuery } from "./useSandboxQuery";
import { useEnvironment } from "./useEnvironment";

/* The sandbox daemon's self-report (/info): its running `version` and — once the daemon has checked GitHub —
 * the `latest` published release plus `updateAvailable`. ONE shared query (vue-query dedupes on the key) feeds
 * both the /sandbox hub card and the global update banner, mirroring useEnvironment. The update itself runs on
 * the host (the sandbox has no Docker socket) via a token-free one-liner — the same shape as the environment
 * rebuild command, minus the hash (the :stable base is trusted by its tag). */

const INFO_KEY = sandboxKey(`info`);

// Per-sandbox "don't nudge me about this version again", keyed by the version dismissed — so a NEWER release
// (latest !== dismissed) re-shows the banner on its own. Same `intentic.<key>` convention as useSandbox/useLayout.
const dismissedStorageKey = (sandboxId: string): string => `intentic.dismissedSandboxVersion.${sandboxId}`;

const { activeSandboxId } = useSandbox();

const readDismissed = (id: string | undefined): string | undefined => {
    if (id === undefined) {
        return undefined;
    }
    try {
        return localStorage.getItem(dismissedStorageKey(id)) ?? undefined;
    } catch {
        return undefined;
    }
};

// Reactive singleton (like useLayout's persisted refs): the version dismissed for the ACTIVE sandbox, re-read
// when the active sandbox changes and written by dismiss(). localStorage isn't reactive on its own.
const dismissedVersion = ref<string | undefined>(readDismissed(activeSandboxId.value));
watch(activeSandboxId, (id) => {
    dismissedVersion.value = readDismissed(id);
});

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

    // The banner is shown only when an update is available AND the user hasn't dismissed THIS version.
    const bannerVisible = computed(() => updateAvailable.value && dismissedVersion.value !== latest.value);
    const dismiss = (): void => {
        const id = activeSandboxId.value;
        const version = latest.value;
        if (id === undefined || version === undefined) {
            return;
        }
        dismissedVersion.value = version;
        try {
            localStorage.setItem(dismissedStorageKey(id), version);
        } catch {
            // Storage may be unavailable (private mode); the in-memory ref still suppresses the banner this session.
        }
    };

    return { info, installed, latest, updateAvailable, serverManaged, updateCommand, bannerVisible, dismiss };
}
