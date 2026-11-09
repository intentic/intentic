// THE ROSTER LINK: who is signed in and the sandboxes this page's switcher lists, as one `intentic://roster` link the
// desktop app takes for its local windows (setup_link.rs `roster`). Pure, so the rules the app holds a link to are
// met here and asserted without a window; desktop.ts `announceDesktopRoster` hands the link over.

// A local window cannot ask the platform (it holds no session, and its page reaches nothing but loopback and the app),
// so the account its rail shows and the sandboxes its switcher lists are what this page last told the app. One row per
// sandbox in the switcher's order, and nothing a row is not drawn from: no address or token. (2026-11-09) A logo rides
// too, as the thumbnail this device remembers (client/directory/logoThumbnail.ts), so a local window and the app's own
// copy of the editor show it with the platform down; only small ones, within one budget per link, since the link is a
// navigation and a browser caps those near 2 MB. The app takes this only from its own windows (setup_link.rs `roster`).
export interface DesktopRosterEntry {
    readonly id: string;
    readonly name: string;
    /** Where it runs, as the switcher marks it (placement.ts `SandboxPlacementKind`). */
    readonly place: string;
    /** Somebody else's sandbox, shared with this account. */
    readonly shared: boolean;
    /** Its logo as a small `data:image/` URL; left out where it has none, or none small enough. */
    readonly image?: string;
}

/** The signed-in account as the rail's account control shows it. */
export interface DesktopRosterAccount {
    readonly email: string;
    readonly name?: string | null;
    readonly image?: string | null;
}

// What the app holds a row and the account to (setup_link.rs `is_roster_entry`, `is_roster_account`), met here rather
// than refused there: the whole link is dropped for one value it cannot take. Text is cut by characters, never inside
// one, and a control character is a space; an account with no usable address is not sent, and an avatar only as an
// https address (an uploaded one is an inline data URL).
const ROSTER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ROSTER_NAME_MAX = 200;
const CONTROL = /\p{Cc}/gu;
const EMAIL = /^[^\s@]+@[^\s@]+$/;
const IMAGE_MAX = 2048;
const shownText = (text: string): string => Array.from(text.replace(CONTROL, ` `).trim()).slice(0, ROSTER_NAME_MAX).join(``);
// A logo the app keeps (setup_link.rs `is_roster_image` takes up to 64 KB); the page sends far smaller ones, and stops
// sending them once a link carries ROSTER_IMAGES_BUDGET of them, so a long list never makes a link too long to open.
export const ROSTER_IMAGE_MAX = 24_000;
export const ROSTER_IMAGES_BUDGET = 600_000;
const rosterImage = (image: string | undefined): string | undefined =>
    image !== undefined && image.startsWith(`data:image/`) && image.length <= ROSTER_IMAGE_MAX ? image : undefined;
const rosterRow = (entry: DesktopRosterEntry): DesktopRosterEntry | undefined => {
    if (!ROSTER_ID.test(entry.id)) {
        return undefined;
    }
    const name = shownText(entry.name);
    const row = { id: entry.id, name: name === `` ? entry.id : name, place: entry.place, shared: entry.shared };
    const image = rosterImage(entry.image);
    return image === undefined ? row : { ...row, image };
};
// Each row's logo while the budget lasts, in the switcher's order; the rest go without.
const withinImageBudget = (rows: readonly DesktopRosterEntry[]): DesktopRosterEntry[] => {
    let spent = 0;
    return rows.map((row) => {
        if (row.image === undefined) {
            return row;
        }
        spent += row.image.length;
        if (spent <= ROSTER_IMAGES_BUDGET) {
            return row;
        }
        const { image: _dropped, ...bare } = row;
        return bare;
    });
};
const httpsImage = (image: string | null | undefined): string | undefined =>
    image !== null && image !== undefined && image.length <= IMAGE_MAX && URL.canParse(image) && new URL(image).protocol === `https:`
        ? image
        : undefined;
// The account as the link carries it (setup_link.rs `RosterAccount`): a name and an avatar only where there are any.
interface SentAccount {
    email: string;
    name?: string;
    image?: string;
}
const rosterAccount = (account: DesktopRosterAccount): SentAccount | undefined => {
    if (account.email.length > 320 || !EMAIL.test(account.email)) {
        return undefined;
    }
    const sent: SentAccount = { email: account.email };
    const name = shownText(account.name ?? ``);
    if (name !== ``) {
        sent.name = name;
    }
    const image = httpsImage(account.image);
    if (image !== undefined) {
        sent.image = image;
    }
    return sent;
};

export const desktopRosterLink = (entries: readonly DesktopRosterEntry[], account?: DesktopRosterAccount): string => {
    const rows = withinImageBudget(entries.map(rosterRow).filter((row): row is DesktopRosterEntry => row !== undefined));
    const params = new URLSearchParams({ list: JSON.stringify(rows) });
    const signedIn = account === undefined ? undefined : rosterAccount(account);
    if (signedIn !== undefined) {
        params.set(`account`, JSON.stringify(signedIn));
    }
    return `intentic://roster?${params.toString()}`;
};
