import { errorMessage } from "@intentic/base/errors";
import type { CloudflareApi } from "@intentic/providers";
import { selectZone } from "@intentic/state-resolver";

// Resolve the zone (id + account) a bootstrap hostname lives under: an explicit override (getZone), else the token's
// sole zone, chosen by the rule `resolve` picks a deploy's zone with (state-resolver's selectZone, here with no domains
// declared), erroring when the token sees none or several (the operator must then set ZONE).
export const resolveZone = async (
    api: CloudflareApi,
    apiToken: string,
    override: string | undefined,
): Promise<{ id: string; name: string; accountId: string }> => {
    if (override !== undefined && override !== "") {
        const found = await api.getZone({ apiToken, zone: override });
        if (found === undefined) {
            throw new Error(`Cloudflare zone "${override}" not found for this API token`);
        }
        return { id: found.id, name: override, accountId: found.accountId };
    }
    const zones = await api.listZones({ apiToken });
    let name: string;
    try {
        name = selectZone(
            zones.map((zone) => zone.name),
            [],
        );
    } catch (error) {
        // Several zones is the one refusal a flag answers; no zones at all is the token's to fix.
        const hint = zones.length > 1 ? `: set the ZONE env var or pass --zone to choose one, e.g. --zone ${zones[0]?.name ?? ""}` : "";
        throw new Error(`${errorMessage(error)}${hint}`, { cause: error });
    }
    const chosen = zones.find((zone) => zone.name === name);
    if (chosen === undefined) {
        throw new Error(`Cloudflare zone "${name}" vanished from the token's listing`);
    }
    return chosen;
};
