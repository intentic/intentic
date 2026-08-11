import { computed, onUnmounted, ref } from "vue";
import { errorMessage } from "@intentic/ui/async";
import { devFillGet, devFillSet } from "../devFill";
import { apiClient } from "../useApi";

/* Cloudflare API token + zone discovery, shared by the onboarding Setup screen and the in-app "Connect
 * Cloudflare" step. The token is sent to the platform only for a request-scoped zone listing
 * (apiClient.sandbox.zones drops it); everything else here is local UI state. Bindings mirror what the
 * consumers render: cfToken/cfTokenValid, the discovered zones + selectedZone, and loading/error flags. */

/* The .env key the token lands under in the sandbox. Exported because three files named it independently —
 * this module's dev-autofill slot, the connect step that writes it, and the field that collects it — and a
 * secret whose name is spelled in three places is one that gets written under two of them. */
export const CF_TOKEN_KEY = `CLOUDFLARE_API_TOKEN`;

// Lenient format check (Cloudflare tokens are 40 chars of [A-Za-z0-9_-]); just catches copy/paste slips.
const TOKEN_RE = /^[A-Za-z0-9_-]{30,}$/;

export function useCloudflareZones() {
    const cfToken = ref(``);
    const cfTokenValid = computed(() => TOKEN_RE.test(cfToken.value.trim()));
    // Zones the token can see, discovered (debounced) via sandbox.zones once the token looks valid.
    const zones = ref<string[]>([]);
    const selectedZone = ref<string | undefined>(undefined);
    const zonesLoading = ref(false);
    const zonesError = ref<string | undefined>(undefined);
    let zoneTimer: ReturnType<typeof setTimeout> | undefined;

    const loadZones = async (token: string): Promise<void> => {
        try {
            const { zones: found } = await apiClient.sandbox.zones({ token });
            if (token !== cfToken.value.trim()) {
                return;
            }
            zones.value = found;
            selectedZone.value = found.length === 1 ? found[0] : undefined;
            if (found.length === 0) {
                zonesError.value = `This token can't see any Cloudflare zones — add a domain to the account or broaden its Zone:Read scope.`;
            }
        } catch (err) {
            if (token !== cfToken.value.trim()) {
                return;
            }
            zones.value = [];
            selectedZone.value = undefined;
            zonesError.value = errorMessage(err, `Couldn't check this token's Cloudflare zones.`);
        } finally {
            if (token === cfToken.value.trim()) {
                zonesLoading.value = false;
            }
        }
    };

    // Update the token and (debounced) discover its zones. Clearing the zone state first keeps callers
    // locked while we re-check; stale in-flight responses are dropped by comparing the token they fired for.
    const setToken = (value: string): void => {
        cfToken.value = value;
        clearTimeout(zoneTimer);
        zones.value = [];
        selectedZone.value = undefined;
        zonesError.value = undefined;
        if (!cfTokenValid.value) {
            zonesLoading.value = false;
            return;
        }
        // Dev autofill persist (inert in prod) — Setup's ride-the-command flow never hits a secrets mutation,
        // so a valid token is remembered here, under the same key CloudflareConnect saves it as.
        devFillSet(`secret.${CF_TOKEN_KEY}`, cfToken.value.trim());
        zonesLoading.value = true;
        zoneTimer = setTimeout(() => void loadZones(cfToken.value.trim()), 400);
    };

    // Dev autofill seed: prefill the last-used token (and fire zone discovery) on both consumers' mounts.
    const remembered = devFillGet(`secret.${CF_TOKEN_KEY}`);
    if (remembered !== undefined) {
        setToken(remembered);
    }

    onUnmounted(() => clearTimeout(zoneTimer));

    return { cfToken, cfTokenValid, zones, selectedZone, zonesLoading, zonesError, setToken };
}
