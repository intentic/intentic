import type { TriggerSource } from "@intentic/sandbox-contract";
import { extensionIdOf } from "@intentic/extension-manifest";
import { registerExtensionMessages } from "@intentic/extension-ui/i18n";
import { sourceWords } from "./catalog";
import { messages } from "./i18n";
import base from "./locales/en.json";
import { manifest } from "./manifest";

await registerExtensionMessages(extensionIdOf(manifest), messages);

// The Microsoft 365 pack's listener as the daemon serves it, in the English en.json holds for it. That this English is
// still the pack's own is held by the web's listenerWords.test.ts, which may read another extension's manifest.
const words = base.catalog.microsoft365;
const microsoft: TriggerSource = {
    provider: `microsoft365`,
    label: `Microsoft 365`,
    events: [{ value: `mail`, label: words.mail }],
    mentionLabel: words.mention,
    channel: { label: words.folder, placeholder: `inbox` },
    sender: { label: words.sender, placeholder: `name@example.com`, hint: words.senderHint },
    starterPrompt: `New Outlook mail just arrived.`,
    requires: [],
    enabled: true,
};

// The Polish itself is a plain catalog lookup (i18n-keys holds pl.json to en.json); what is tested here is when it is
// looked up at all.
test(`the listener's labels are looked up while the pack says what en.json holds, and nothing it stores changes`, () => {
    const shown = sourceWords(microsoft);

    expect(shown.events).toEqual([{ value: `mail`, label: `New Outlook mail` }]);
    expect([shown.channel.label, shown.channel.placeholder, shown.sender?.label]).toEqual([`Folder (optional)`, `inbox`, `Sender address`]);
    expect([shown.provider, shown.starterPrompt]).toEqual([microsoft.provider, microsoft.starterPrompt]);
    // A label the pack has changed since keeps its own words; another pack is left alone.
    expect(sourceWords({ ...microsoft, mentionLabel: `Only mail to the team` }).mentionLabel).toBe(`Only mail to the team`);
    const other = { ...microsoft, provider: `google` };
    expect(sourceWords(other)).toBe(other);
});
