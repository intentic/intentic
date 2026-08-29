import type { HostConfig } from "@intentic/sandbox-contract";
import { capabilityCtx } from "../capabilities/capability.js";
import { hostHandler } from "../capabilities/handlers/host.js";
import type { Services } from "../composition.js";

/* THE COMPUTER THAT RAN THE INSTALLER, CONNECTED WITHOUT ANYONE ASKING FOR IT.
 *
 * Setting a sandbox up has always connected desktop sync, and desktop sync deliberately never reports containers
 *, a sync agent enumerating a machine's OTHER sandboxes to one of them is the disclosure that design avoids by
 * construction. So the machine that just installed this sandbox appeared in the Computers view with its folders
 * and its ports and no sandboxes at all, and the one thing a person goes there to do, restart the sandbox that
 * has wedged, was a command to paste on a machine they might not be sitting at.
 *
 * This closes that: the setup flow installs the machine agent too, and this is the daemon's half, it creates the
 * computer's own capability card and arms the one-time pairing the flow carries.
 *
 * WHAT IT GRANTS IS THE WHOLE ARGUMENT. Nothing about the machine except its sandboxes: no shell, no files, no
 * screen, no keyboard, and not removal either. That is narrower than the card's own defaults (`shell` is `on`
 * when a person adds a computer deliberately, because that is what they came for) and it has to be, a person
 * who installed a sandbox consented to running a sandbox, not to handing the agent inside it a shell on their
 * laptop. The card is right there in Capabilities, saying exactly this, and every wider switch is one click away
 * for someone who wants it. Making that click is a decision; making it FOR them is not ours to make.
 *
 * The token is armed once, ever. See HostsStore.seedPairing for why that matters more here than it does for
 * sync's equivalent. */

// What a setup-connected computer may do. Written out in full rather than spread over the schema's defaults,
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
    return cleaned === undefined || cleaned === "" ? "this-computer" : cleaned;
};

// The OS slugs the bundled computers extension declares cards for. A setup on anything else connects no computer
// rather than writing a card whose apply would fail on the extension lookup.
const KNOWN_PLATFORMS = new Set(["linux", "windows"]);

/* Arm the setup-time host pairing, creating the machine's card if this is the first time.
 *
 * Answers whether the pairing is live, so the caller can say nothing at all on the ordinary boot where it was
 * spent months ago. An EXISTING card is left exactly as it is: the owner may have widened or narrowed it since,
 * and re-running the installer must not quietly reset somebody's permissions to these defaults. */
export const seedSetupHost = async (
    services: Services,
    seed: { readonly token: string; readonly platform: string; readonly label: string },
): Promise<{ armed: boolean; id: string }> => {
    const id = hostIdFrom(seed.label);
    if (seed.token === "" || !KNOWN_PLATFORMS.has(seed.platform)) {
        return { armed: false, id };
    }
    // Armed BEFORE the card is written, because the burn check is what makes this a no-op on every later boot,
    // and doing the capability work first would rewrite a skill pack once per restart for nothing.
    if (!(await services.hosts.seedPairing(id, seed.token))) {
        return { armed: false, id };
    }
    const existing = (await services.capabilities.list()).find((capability) => capability.id === id && capability.kind === "host");
    if (existing !== undefined) {
        return { armed: true, id };
    }
    const config: HostConfig = { platform: seed.platform, ...SETUP_HOST_SCOPES };
    // The handler writes the machine's skill pack and pushes the grant if it is already up; its progress frames
    // have no reader here (there is no browser attached to a boot), so they are drained.
    for await (const frame of hostHandler.apply(capabilityCtx(services), id, config)) {
        void frame;
    }
    await services.capabilities.upsert({ id, kind: "host", config });
    return { armed: true, id };
};
