import { extensionIdOf } from "@intentic/extension-manifest";
import { registerExtensionMessages } from "@intentic/extension-ui/i18n";
import { messages } from "../i18n";
import { manifest } from "../manifest";
import { serviceSummary } from "./serviceSummary";
import { answersPhrase } from "../senderSummary";
await registerExtensionMessages(extensionIdOf(manifest), messages);
const service = { id: `support`, steward: `support@example.test`, profile: `limited` };
test(`summarizes a profile including empty account and connection lists`, () => {
    expect(serviceSummary(service, [{ id: `limited`, label: `Limited`, origin: `sandbox`, tools: { files: `read`, shell: false }, credentials: { capabilities: [], secrets: [] }, aiAccounts: [] }])).toBe(`Steward: support@example.test · Limited · Read-only files · No commands · Connections: 0 · AI accounts: None`);
});
test(`distinguishes unavailable profiles from unrestricted steward access`, () => {
    expect(serviceSummary(service, [])).toBe(`Steward: support@example.test · Profile unavailable: limited`);
    expect(serviceSummary({ id: `support`, steward: service.steward }, [])).toBe(`Steward: support@example.test · All steward access`);
});
test(`names per-rule authority in sender summaries`, () => {
    expect(answersPhrase({ rules: [{ label: `Team`, ids: [`u`], runAs: `support` }], others: `hold` })).toContain(`Team: runs as support`);
});
