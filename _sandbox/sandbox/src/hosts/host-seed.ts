import { join } from "node:path";
import { collidesWithReservedServer, type DeviceConfig } from "@intentic/sandbox-contract";
import { z } from "zod";
import { capabilityCtx } from "../capabilities/capability.js";
import { deviceHandler } from "../capabilities/handlers/device.handler.js";
import type { Services } from "../composition.js";
import { jsonFile } from "../store/json-file.js";

// Setup auto-connects the machine that ran the installer, granted only `sandboxes` (no shell, files or screen):
// consenting to run a sandbox is not consenting to a shell on your own laptop. The card is created once ever; the
// pairing re-arms every boot since only redemption burns it. Already-seeded ids are remembered on /history so a
// deleted card is never re-offered.

// What a setup-connected device may do; spelled out in full as this feature's whole security posture.
export const SETUP_HOST_SCOPES = {
    shell: "off",
    write: "off",
    screen: "off",
    control: "off",
    sandboxes: "on",
    destructive: "off",
} as const;

// The machine's name in the UI, from the reported hostname; normalized as a person would write it, and never empty
// since an unnamed card is one nobody can find again. The id is also the device's MCP server name, so a hostname the
// daemon's own servers already answer to (`web`, `code`) is set apart, or the machine's tools would never mount.
export const hostIdFrom = (label: string): string => {
    const cleaned = label
        .trim()
        .toLowerCase()
        // The leading DNS label only: a machine calling itself `ada-laptop.lan` is `ada-laptop` here.
        .split(".")[0]
        ?.replaceAll(/[^a-z0-9-]+/g, "-")
        .replaceAll(/^-+|-+$/g, "");
    if (cleaned === undefined || cleaned === "") {
        return "this-device";
    }
    return collidesWithReservedServer("device", cleaned) ? `${cleaned}-device` : cleaned;
};

// OS slugs the devices extension has cards for; other platforms connect no device instead of failing apply.
const KNOWN_PLATFORMS = new Set(["linux", "windows"]);

const SeededSchema = z.object({ ids: z.array(z.string()) });

// Which setup cards this sandbox has already offered, not whether the machine is connected or the token spent
// (host-peer.ts); its own file since it outlives both of those.
const seededCards = (historyRoot: string) =>
    jsonFile<z.infer<typeof SeededSchema>>(join(historyRoot, "host-setup-seeded.json"), {
        parse: (raw) => SeededSchema.safeParse(raw).data,
        fallback: () => ({ ids: [] }),
        mode: 0o600,
    });

// Arms the setup pairing, creating the card on first run. Returns whether a card was written, not whether the pairing
// is live; an existing card is left exactly as it is, never reset to these defaults.
export const seedSetupHost = async (
    services: Services,
    seed: { readonly token: string; readonly platform: string; readonly label: string },
): Promise<{ offered: boolean; id: string }> => {
    const id = hostIdFrom(seed.label);
    if (seed.token === "" || !KNOWN_PLATFORMS.has(seed.platform)) {
        return { offered: false, id };
    }
    // Armed before the card is written: the burn check is what makes this a no-op once the machine has enrolled.
    if (!(await services.hosts.seedPairing(id, seed.token))) {
        return { offered: false, id };
    }
    const seeded = seededCards(services.config.historyRoot);
    // Offered once; whether the card still exists or was deleted is not this function's concern from here on.
    if ((await seeded.read()).ids.includes(id)) {
        return { offered: false, id };
    }
    const existing = (await services.capabilities.list()).find((capability) => capability.id === id && capability.kind === "device");
    if (existing === undefined) {
        const config: DeviceConfig = { platform: seed.platform, ...SETUP_HOST_SCOPES };
        // Drains the handler's progress frames; nothing reads them at boot, though it still writes the pack and grant.
        for await (const frame of deviceHandler.apply(capabilityCtx(services), id, config)) {
            void frame;
        }
        await services.capabilities.upsert({ id, kind: "device", config });
    }
    // Also records a pre-existing card, so a sandbox older than this file gets fixed on its first boot here.
    await seeded.update((stored) => (stored.ids.includes(id) ? stored : { ids: [...stored.ids, id] }));
    return { offered: existing === undefined, id };
};
