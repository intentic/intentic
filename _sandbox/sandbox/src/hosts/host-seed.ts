import { join } from "node:path";
import type { HostConfig } from "@intentic/sandbox-contract";
import { z } from "zod";
import { capabilityCtx } from "../capabilities/capability.js";
import { hostHandler } from "../capabilities/handlers/host.handler.js";
import type { Services } from "../composition.js";
import { jsonFile } from "../store/json-file.js";

/* THE DEVICE THAT RAN THE INSTALLER, CONNECTED WITHOUT ANYONE ASKING FOR IT.
 *
 * Setting a sandbox up has always connected desktop sync, and desktop sync deliberately never reports containers
 *, a sync agent enumerating a machine's OTHER sandboxes to one of them is the disclosure that design avoids by
 * construction. So the machine that just installed this sandbox appeared in the Devices view with its folders
 * and its ports and no sandboxes at all, and the one thing a person goes there to do, restart the sandbox that
 * has wedged, was a command to paste on a machine they might not be sitting at.
 *
 * This closes that: the setup flow installs the machine agent too, and this is the daemon's half, it creates the
 * device's own capability card and arms the one-time pairing the flow carries.
 *
 * WHAT IT GRANTS IS THE WHOLE ARGUMENT. Nothing about the machine except its sandboxes: no shell, no files, no
 * screen, no keyboard, and not removal either. That is narrower than the card's own defaults (`shell` is `on`
 * when a person adds a device deliberately, because that is what they came for) and it has to be, a person
 * who installed a sandbox consented to running a sandbox, not to handing the agent inside it a shell on their
 * laptop. The card is right there in Capabilities, saying exactly this, and every wider switch is one click away
 * for someone who wants it. Making that click is a decision; making it FOR them is not ours to make.
 *
 * THE CARD IS CREATED ONCE, EVER; THE PAIRING IS NOT. Those are two lifetimes, and collapsing them into one
 * was a bug with a long tail. A seeded pairing is only burned when it is REDEEMED (store/enrollment.ts), so a
 * machine whose agent never enrolls — it enrolled under another id, it was never started, the installer half
 * finished — leaves the token armable forever, and this function ran its whole body on every boot. Deleting the
 * device's card was therefore un-doable: it came back at the next restart, with a dead MCP server attached to
 * it, and the owner had no way to tell the sandbox they meant it.
 *
 * Re-arming has to keep happening: the pairing lives in memory with a ten-minute TTL, so a machine agent that
 * comes up after a restart still needs a live token to enroll against. What must not repeat is the CARD, so the
 * ids this has already seeded are remembered on /history — beside the burn list, outside /work, surviving the
 * `docker rm -f` of a rebuild — and a remembered id is never written a second time. Deleting the card is then a
 * decision that sticks, and a late machine agent can still connect to it. */

// What a setup-connected device may do. Written out in full rather than spread over the schema's defaults,
// because "which switches are on when nobody chose" is the security posture of this whole feature and belongs
// where it can be read in one line.
export const SETUP_HOST_SCOPES = {
    shell: "off",
    write: "off",
    screen: "off",
    control: "off",
    sandboxes: "on",
    sandboxRemove: "off",
    destructive: "off",
} as const;

/* The machine's name in the UI, from the hostname the setup flow reported. It becomes the capability id, which
 * the agent uses to address the machine ("run the tests on my-laptop"), so it is normalized the way a person
 * would write it rather than left as whatever the OS answers, and it is never empty, because an unnamed card is
 * one nobody can find again. */
export const hostIdFrom = (label: string): string => {
    const cleaned = label
        .trim()
        .toLowerCase()
        // The leading DNS label only: a machine calling itself `ada-laptop.lan` is `ada-laptop` here.
        .split(".")[0]
        ?.replaceAll(/[^a-z0-9-]+/g, "-")
        .replaceAll(/^-+|-+$/g, "");
    return cleaned === undefined || cleaned === "" ? "this-device" : cleaned;
};

// The OS slugs the bundled devices extension declares cards for. A setup on anything else connects no device
// rather than writing a card whose apply would fail on the extension lookup.
const KNOWN_PLATFORMS = new Set(["linux", "windows"]);

const SeededSchema = z.object({ ids: z.array(z.string()) });

/* WHICH SETUP CARDS THIS SANDBOX HAS ALREADY WRITTEN. Its own file rather than a field on the host door's
 * enrollment or burn records (host-peer.ts names those), because it answers a question about neither: not "is
 * this machine connected" and not "has this token been spent", but "did we already offer the owner this card".
 * The three have different lifetimes — an enrollment is revoked when a device is dropped, a burn is permanent,
 * and this outlives both, since re-offering a card the owner deleted is the thing it exists to prevent. */
const seededCards = (historyRoot: string) =>
    jsonFile<z.infer<typeof SeededSchema>>(join(historyRoot, "host-setup-seeded.json"), {
        parse: (raw) => SeededSchema.safeParse(raw).data,
        fallback: () => ({ ids: [] }),
        mode: 0o600,
    });

/* Arm the setup-time host pairing, creating the machine's card if this is the first time.
 *
 * Answers whether a card was WRITTEN, not whether the pairing is live, and the difference is what keeps the
 * boot log honest: the line it feeds tells the owner to widen or revoke the device on its capability card, and
 * on every boot after the first there is no card to point at — either because they never touched it, or
 * because they deleted it. An EXISTING card is left exactly as it is: the owner may have widened or narrowed
 * it since, and re-running the installer must not quietly reset somebody's permissions to these defaults. */
export const seedSetupHost = async (
    services: Services,
    seed: { readonly token: string; readonly platform: string; readonly label: string },
): Promise<{ offered: boolean; id: string }> => {
    const id = hostIdFrom(seed.label);
    if (seed.token === "" || !KNOWN_PLATFORMS.has(seed.platform)) {
        return { offered: false, id };
    }
    // Armed BEFORE the card is written, because the burn check is what makes this a no-op once the machine has
    // enrolled, and doing the capability work first would rewrite a skill pack once per restart for nothing.
    if (!(await services.hosts.seedPairing(id, seed.token))) {
        return { offered: false, id };
    }
    const seeded = seededCards(services.config.historyRoot);
    // Offered once. Whether the card is still there or the owner has since deleted it is not this function's
    // business: either way it has had its say, and the pairing above stays armed for a late machine agent.
    if ((await seeded.read()).ids.includes(id)) {
        return { offered: false, id };
    }
    const existing = (await services.capabilities.list()).find((capability) => capability.id === id && capability.kind === "host");
    if (existing === undefined) {
        const config: HostConfig = { platform: seed.platform, ...SETUP_HOST_SCOPES };
        // The handler writes the machine's skill pack and pushes the grant if it is already up; its progress
        // frames have no reader here (there is no browser attached to a boot), so they are drained.
        for await (const frame of hostHandler.apply(capabilityCtx(services), id, config)) {
            void frame;
        }
        await services.capabilities.upsert({ id, kind: "host", config });
    }
    /* Recorded for the card that was already there too, and that is the half that repairs a sandbox set up
     * before this file existed: the first boot on this build remembers what setup left behind, so the owner's
     * NEXT delete is the last one they have to make. */
    await seeded.update((stored) => (stored.ids.includes(id) ? stored : { ids: [...stored.ids, id] }));
    return { offered: existing === undefined, id };
};
