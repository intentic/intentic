// compliance: what a data protection officer (in Poland, the IOD) needs before a sandbox handles anyone's personal data,
// read off the sandbox's LIVE configuration rather than written from memory. Three answers: where data can leave
// (`flows`), what protects it (`measures`), and the documents an office files about it (the record of processing under
// GDPR Art. 30, the impact assessment under Art. 35, the technical and organisational measures under Art. 32). Plus the
// public-office preset: a list of stricter settings, each shown as current → proposed, applied only item by item on
// request. Nothing here changes a default; a sandbox that never opens the page behaves as it did before it existed.
import { z } from "zod";

export const ComplianceLanguageSchema = z.enum(["pl", "en"]);
export type ComplianceLanguage = z.infer<typeof ComplianceLanguageSchema>;

// The groups the data-flow page draws, in this order.
export const DATA_FLOW_GROUPS = ["models", "messaging", "connectors", "speech", "web", "platform", "maintenance", "analytics"] as const;
export const DataFlowGroupSchema = z.enum(DATA_FLOW_GROUPS);
export type DataFlowGroup = z.infer<typeof DataFlowGroupSchema>;

// One kind per outbound path the code has; the editor and the documents both word each kind in the reader's language,
// so the daemon sends the kind and the facts, never a sentence.
export const DATA_FLOW_KINDS = [
    "model-provider",
    "model-endpoint",
    "local-model",
    "email-imap",
    "email-smtp",
    "team-chat",
    "webchat",
    "connector",
    "speech",
    "web-search",
    "web-fetch",
    "browser",
    "platform-link",
    "ingress",
    "update-check",
    "model-download",
    "product-analytics",
    "push-notifications",
] as const;
export const DataFlowKindSchema = z.enum(DATA_FLOW_KINDS);
export type DataFlowKind = z.infer<typeof DataFlowKindSchema>;

// Whether personal data can ride this path: `yes` when it carries what people wrote, `possible` when only what an agent
// chose to send or look up, `no` when it carries only the sandbox's own metadata.
export const PersonalDataReachSchema = z.enum(["yes", "possible", "no"]);
export type PersonalDataReach = z.infer<typeof PersonalDataReachSchema>;

// What the privacy shield does on this path: `masked` (personal data becomes tokens before it leaves), `trusted` (the
// shield is on but lets this destination read values as they are), `watched` (the shield only records), `local` (it
// never leaves the machine), `blocked` (the shield is on and refuses what it cannot read, so nothing is sent unmasked),
// `none` (the shield does not sit on this path, or is off).
export const ShieldCoverSchema = z.enum(["masked", "trusted", "watched", "local", "blocked", "none"]);
export type ShieldCover = z.infer<typeof ShieldCoverSchema>;

export const DataFlowSchema = z.object({
    id: z.string().describe("Stable id of this path, such as `model-provider:claude` or `team-chat:discord`."),
    group: DataFlowGroupSchema,
    kind: DataFlowKindSchema,
    name: z.string().describe("The destination's own name, such as Anthropic Claude or a connector's title. Proper nouns only."),
    hosts: z.array(z.string()).describe("The hosts data is sent to, as configured. Empty when the code cannot know them in advance."),
    operator: z.string().optional().describe("Who runs the destination, where known."),
    region: z.string().optional().describe("Where it is processed, as far as the operator says: `EU`, `US`, `this machine`, or a hosting region."),
    thirdCountry: z
        .boolean()
        .optional()
        .describe("True when the operator processes the data outside the European Economic Area, which makes this a transfer to a third country."),
    active: z.boolean().describe("Whether this path is in use now. An inactive one is listed because a single switch would open it."),
    personalData: PersonalDataReachSchema,
    shield: ShieldCoverSchema,
    switch: z
        .string()
        .optional()
        .describe("What opens or closes this path: a settings key (`productAnalytics`), a page, or an environment variable."),
    question: z
        .string()
        .optional()
        .describe("Set when the sandbox cannot tell something about this path and the office must answer it, as a short key the editor words."),
});
export type DataFlow = z.infer<typeof DataFlowSchema>;

// `on`: in place. `partial`: in place for some of what it covers. `off`: available, switched off. `unavailable`: this
// sandbox cannot offer it as it runs now. `unknown`: outside what the sandbox can see (backups), so the office says.
export const MeasureStatusSchema = z.enum(["on", "partial", "off", "unavailable", "unknown"]);
export type MeasureStatus = z.infer<typeof MeasureStatusSchema>;

export const MEASURE_IDS = [
    "privacy-shield",
    "privacy-images",
    "privacy-names",
    "trusted-providers",
    "local-models",
    "member-roles",
    "areas",
    "guest-jail",
    "sign-in",
    "action-rules",
    "admission",
    "command-judge",
    "credential-gates",
    "host-guards",
    "retention",
    "audit",
    "audit-reads",
    "audit-forward",
    "encryption-at-rest",
    "encryption-in-transit",
    "agent-domain",
    "product-analytics",
    "ai-notice",
    "webchat-ai-disclosure",
    "backups",
] as const;
export const MeasureIdSchema = z.enum(MEASURE_IDS);
export type MeasureId = z.infer<typeof MeasureIdSchema>;

// The TOMs categories of GDPR Art. 32(1) the documents sort measures under.
export const MeasureCategorySchema = z.enum(["confidentiality", "minimisation", "integrity", "accountability", "transparency", "availability"]);
export type MeasureCategory = z.infer<typeof MeasureCategorySchema>;

export const MeasureSchema = z.object({
    id: MeasureIdSchema,
    category: MeasureCategorySchema,
    status: MeasureStatusSchema,
    facts: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
        .describe("The configured values behind the status, such as `{ mode: \"on\", trusted: 2 }`, for the reader to word."),
    preset: z.boolean().describe("The public-office preset changes this measure."),
});
export type Measure = z.infer<typeof MeasureSchema>;

export const ComplianceReportSchema = z.object({
    generatedAt: z.string().describe("When this was read, as an ISO timestamp."),
    flows: z.array(DataFlowSchema),
    measures: z.array(MeasureSchema),
});
export type ComplianceReport = z.infer<typeof ComplianceReportSchema>;

export const ComplianceDocumentKindSchema = z.enum(["ropa", "dpia", "toms"]);
export type ComplianceDocumentKind = z.infer<typeof ComplianceDocumentKindSchema>;
export const ComplianceDocumentFormatSchema = z.enum(["md", "docx"]);
export type ComplianceDocumentFormat = z.infer<typeof ComplianceDocumentFormatSchema>;

export const ComplianceDocumentQuerySchema = z.object({
    kind: ComplianceDocumentKindSchema.describe("ropa: the record of processing activities entry. dpia: the impact assessment draft. toms: the measures."),
    language: ComplianceLanguageSchema.default("pl").describe("pl or en."),
    format: ComplianceDocumentFormatSchema.default("md").describe("md for Markdown text, docx for a Word document."),
});
export type ComplianceDocumentQuery = z.input<typeof ComplianceDocumentQuerySchema>;

export const ComplianceDocumentSchema = z.object({
    filename: z.string(),
    mediaType: z.string(),
    encoding: z.enum(["utf8", "base64"]).describe("utf8 for Markdown, base64 for a Word document's bytes."),
    content: z.string(),
});
export type ComplianceDocument = z.infer<typeof ComplianceDocumentSchema>;

// The preset. Each item is one setting, keyed by where it lives: `privacy.mode`, `retention.transcriptDays`,
// `actionRules.discord.message.send`, `admission.webchat`. A value absent today (an action rule nobody wrote) is null.
export const PresetValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type PresetValue = z.infer<typeof PresetValueSchema>;

export const PRESET_GROUPS = ["privacy", "retention", "audit", "analytics", "notice", "actions", "admission", "judge"] as const;
export const PresetGroupSchema = z.enum(PRESET_GROUPS);
export type PresetGroup = z.infer<typeof PresetGroupSchema>;

export const PresetItemSchema = z.object({
    id: z.string(),
    group: PresetGroupSchema,
    current: PresetValueSchema,
    proposed: PresetValueSchema,
    changes: z.boolean().describe("Applying it would change something; false when the sandbox already has the proposed value."),
    available: z.boolean().describe("It can be applied here. False when what it needs is missing, such as a local name model."),
    owner: z.boolean().describe("Only the owner may apply it, since it changes the privacy shield."),
});
export type PresetItem = z.infer<typeof PresetItemSchema>;

export const PresetPreviewSchema = z.object({ items: z.array(PresetItemSchema) });
export type PresetPreview = z.infer<typeof PresetPreviewSchema>;

export const PRESET_APPLY_MAX = 200;
export const PresetApplySchema = z.object({
    items: z
        .array(z.string().min(1).max(200))
        .min(1)
        .max(PRESET_APPLY_MAX)
        .describe("The ids of the items to apply, as the preview lists them. Anything not named is left as it is."),
});
export type PresetApply = z.infer<typeof PresetApplySchema>;

export const PresetSkipReasonSchema = z.enum(["unknown", "unavailable", "unchanged", "owner"]);
export const PresetApplyResultSchema = z.object({
    applied: z.array(z.string()),
    skipped: z.array(z.object({ id: z.string(), reason: PresetSkipReasonSchema })),
});
export type PresetApplyResult = z.infer<typeof PresetApplyResultSchema>;
