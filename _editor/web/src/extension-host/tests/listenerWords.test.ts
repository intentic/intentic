import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";

// The automations view translates the Microsoft 365 listener's labels (its catalog.ts `sourceWords`), each only while
// the pack still says what the view's en.json holds. This suite reads both packages, which neither extension may do
// for the other: the English held there must be the pack's current English, or the Polish never shows.

const EXTENSIONS = join(repoRoot(import.meta.url), `_extensions`);

interface Listener {
    readonly events: readonly { readonly type: string; readonly label: string }[];
    readonly automation: {
        readonly mentionLabel?: string;
        readonly channel: { readonly label: string };
        readonly sender?: { readonly label: string; readonly hint?: string };
    };
}

const packListener = (): Listener =>
    // SAFETY: a first-party manifest the daemon's own suite parses; only the listener's words are read.
    (JSON.parse(readFileSync(join(EXTENSIONS, `microsoft-365`, `intentic-extension.json`), `utf8`)) as { contributes: { listener: Listener } })
        .contributes.listener;

// The words the view's catalog holds under `catalog.microsoft365`.
interface HeldWords {
    readonly mail: string;
    readonly folder: string;
    readonly mention: string;
    readonly sender: string;
    readonly senderHint: string;
}

const heldWords = (): HeldWords =>
    // SAFETY: the automations view's own catalog; i18n-keys holds its shape to pl.json.
    (JSON.parse(readFileSync(join(EXTENSIONS, `automations`, `src`, `locales`, `en.json`), `utf8`)) as { catalog: { microsoft365: HeldWords } })
        .catalog.microsoft365;

test(`the automations view's words for the Microsoft 365 listener are its manifest's current English`, () => {
    const listener = packListener();

    expect({
        mail: listener.events.find((event) => event.type === `mail`)?.label,
        folder: listener.automation.channel.label,
        mention: listener.automation.mentionLabel,
        sender: listener.automation.sender?.label,
        senderHint: listener.automation.sender?.hint,
    }).toEqual(heldWords());
});
