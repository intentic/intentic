import { titleForOrigin } from "@intentic/sandbox-contract/policy/keyring-origins";
import type { KeyringOrigin } from "@intentic/sandbox-contract/schemas/keyring";
import { timeAgo } from "@intentic/extension-ui/format";
import { t } from "../i18n.js";
import type { AccessLevel, ActivityLine, PasswordCategory, PasswordItem } from "./port.js";

// HOW THE APP SAYS THINGS: a place as a chip, where a password came from, a line of its record as a sentence, and the
// tile a row leads with. Every word comes from the catalog (locales/*.json under `app`), so these are the one place a
// fact of the port becomes a phrase.

/** A place as the "Works on" chip says it: `github.com`, `FortiClient`, `ssh radar@build-01`, `git github.com`, `sudo`. */
export const originLabel = (origin: KeyringOrigin): string => titleForOrigin(origin);

/**
 * Where a password came from, as the list's second line and the detail's header say it: "saved from Brave", "added by
 * hand", "imported from Chrome", "from ssh". A password with no record of it was added before captures existed.
 */
const sourceLine = (captured: PasswordItem[`captured`]): string => {
    if (captured === undefined) {
        return t(`app.source.manual`);
    }
    return t(`app.source.${captured.source}`, { via: captured.via });
};

/** The list's second line: "radarsu · saved from Brave". */
export const rowLine = (item: PasswordItem): string => [item.username, sourceLine(item.captured)].filter((part) => part !== undefined && part !== ``).join(` · `);

/** The detail's header line: "Saved from Brave · 2 hours ago". */
export const savedLine = (item: PasswordItem, now: number): string => {
    const at = item.captured?.at ?? item.createdAt;
    const said = sourceLine(item.captured);
    return `${said.charAt(0).toUpperCase()}${said.slice(1)} · ${timeAgo(at, { now })}`;
};

// The ops the catalog has a sentence for (`app.activity.<op>`); any other is named as the keyring wrote it.
const ACTIVITY_OPS: ReadonlySet<string> = new Set([`type`, `release`, `askpass`, `capture`, `fill`, `need`, `add`, `edit`, `remove`, `share`, `unshare`, `restore`, `reveal`, `copy`]);

const REFUSED: ReadonlySet<string> = new Set([`refused`, `declined`, `denied`, `failed`]);

/**
 * One line of the record as a sentence: "Typed into FortiClient for intentic-dev's agent", "Answered ssh's prompt",
 * "Saved from Brave". A refusal says so after it; an op this app does not know yet is named as the keyring wrote it.
 */
export const activitySentence = (line: ActivityLine): string => {
    const values = {
        program: line.program ?? line.target ?? ``,
        target: line.target ?? line.program ?? ``,
        sandbox: line.sandbox?.label ?? ``,
        // A capture's record names who saw it as its program (`Brave`) and the place as its target (`github.com`).
        via: line.program ?? line.target ?? ``,
    };
    const known = ACTIVITY_OPS.has(line.op);
    let sentence = known ? t(`app.activity.${line.op}`, values) : line.op;
    if (line.sandbox !== undefined && known && line.op !== `share` && line.op !== `unshare` && line.op !== `need`) {
        sentence = t(`app.activity.forAgent`, { what: sentence, sandbox: line.sandbox.label });
    }
    return REFUSED.has(line.outcome) ? t(`app.activity.refused`, { what: sentence }) : sentence;
};

/** What a tile draws: a letter on a colour for a site, a glyph for everything else. */
export type Tile = { readonly kind: `letter`; readonly letter: string; readonly hue: number } | { readonly kind: `glyph`; readonly glyph: `desktop` | `terminal` | `mobile` | `file` | `key` };

// A small stable hash, so github.com is the same colour on every visit and on every computer.
const hueOf = (text: string): number => {
    let hash = 0;
    for (const char of text) {
        hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
    }
    return (hash % 5) + 1;
};

const GLYPHS = {
    app: `desktop`,
    terminal: `terminal`,
    phone: `mobile`,
    note: `file`,
} as const satisfies Readonly<Record<Exclude<PasswordCategory, `site`>, Extract<Tile, { kind: `glyph` }>[`glyph`]>>;

export const tileOf = (item: PasswordItem): Tile => {
    if (item.category !== `site`) {
        return { kind: `glyph`, glyph: GLYPHS[item.category] };
    }
    const first = item.origins[0];
    const host = first?.kind === `site` ? first.host : item.title;
    const letter = (item.title.trim() || host).charAt(0).toUpperCase();
    return letter === `` ? { kind: `glyph`, glyph: `key` } : { kind: `letter`, letter, hue: hueOf(host) };
};

/** The access level's one-sentence explanation under the segmented control. */
export const accessHelp = (level: AccessLevel): string => t(`app.access.help.${level}`);
