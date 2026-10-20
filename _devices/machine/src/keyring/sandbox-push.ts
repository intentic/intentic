import { hostKeyringChangedUrl } from "@intentic/sandbox-contract/protocol/doors/host-protocol";
import { type HostLink, readDeviceConfig } from "../device/config.js";

// Passwords on this computer answered a request or changed its entries: the sandbox reads this keyring at once instead
// of on its minute refresh, which stays as the fallback (2026-10-20). Best-effort: a sandbox that does not answer in
// time still reads it then, so a push never holds the app's answer up for long or fails it.
const PUSH_TIMEOUT_MS = 3_000;

const sameSandbox = (left: string, right: string): boolean => {
    const a = URL.parse(left);
    const b = URL.parse(right);
    return a !== null && b !== null && a.origin === b.origin && a.pathname.replace(/\/+$/u, "") === b.pathname.replace(/\/+$/u, "");
};

/** The links to tell: the one sandbox a request came from, or every link when the change may concern any. Pure. */
export const linksToTell = <Link extends Pick<HostLink, "sandboxUrl">>(links: readonly Link[], sandboxUrl: string | undefined): readonly Link[] =>
    sandboxUrl === undefined ? links : links.filter((link) => sameSandbox(link.sandboxUrl, sandboxUrl));

// Authenticated as the machine's own socket is: its link token, as a bearer.
const tell = async (link: HostLink): Promise<void> => {
    await fetch(hostKeyringChangedUrl(link.sandboxUrl), {
        method: "POST",
        headers: { authorization: `Bearer ${link.token}` },
        signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
        // allow(silent-catch): best-effort; the sandbox's minute refresh reads this keyring anyway.
    }).catch(() => undefined);
};

export const pushKeyringChanged = async (sandboxUrl?: string): Promise<void> => {
    // allow(silent-catch): no readable config means no sandbox to tell; the command it rides on reports its own errors.
    const config = await readDeviceConfig().catch(() => undefined);
    await Promise.all(linksToTell(config?.links ?? [], sandboxUrl).map(tell));
};
