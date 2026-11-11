import type { KeyringOrigin } from "@intentic/sandbox-contract/schemas/keyring";
import type { SandboxNeed } from "@intentic/sandbox-contract/schemas/sandbox-passwords";
import { titleForOrigin } from "@intentic/sandbox-contract/policy/keyring-origins";
import { timeAgo } from "@intentic/ui/format";
import { t } from "@intentic/ui/i18n";

// A WANT AS THE SECRETS VIEW SHOWS IT: a credential an agent asked the owner's computers for by place (`secrets want`,
// `type_secret` with `for`) that nobody has answered yet. It waits in Passwords on the computer named, which is where
// it is answered; here it is a row in "Needs attention", since the turn that asked is waiting on it. Pure, so the words
// are pinned without drawing a row.

export interface WantRow {
    readonly id: string;
    /** Where it is for, as a person names the place: `dashboard.stripe.com`, `FortiClient VPN`, `ssh deploy@web-1`. */
    readonly title: string;
    /** What the agent said it is for. */
    readonly detail: string;
    /** Where the answer is awaited, and since when. */
    readonly note: string;
    readonly icon: string;
    /** Everything the Secrets view's filter box matches, already folded. */
    readonly haystack: string;
}

// A site is a page, a program or a phone app a window, everything else a prompt in a terminal.
const ICONS = {
    site: `globe`,
    program: `desktop`,
    package: `mobile`,
    ssh: `terminal`,
    "ssh-key": `terminal`,
    sudo: `terminal`,
    git: `terminal`,
    prompt: `terminal`,
} as const satisfies Readonly<Record<KeyringOrigin[`kind`], string>>;

const wantRow = (need: SandboxNeed, now: number = Date.now()): WantRow => {
    const place = titleForOrigin(need.origin);
    const title = need.username === undefined ? place : t(`sandbox.sandboxSecrets.wantAs`, { place, username: need.username });
    const when = timeAgo(need.at, { now });
    const note =
        need.machine === undefined
            ? t(`sandbox.sandboxSecrets.wantWaitingSomewhere`, { when })
            : t(`sandbox.sandboxSecrets.wantWaiting`, { machine: need.machine, when });
    return {
        id: need.id,
        title,
        detail: need.detail,
        note,
        icon: ICONS[need.origin.kind],
        haystack: `${title} ${need.detail} ${need.machine ?? ``}`.toLowerCase(),
    };
};

/** The wants still waiting, newest first: the read lists only those, and an older daemon's answer is held to it too. */
export const waitingWants = (needs: readonly SandboxNeed[], now: number = Date.now()): WantRow[] =>
    needs
        .filter((need) => need.state === `pending`)
        .toSorted((left, right) => right.at - left.at)
        .map((need) => wantRow(need, now));
