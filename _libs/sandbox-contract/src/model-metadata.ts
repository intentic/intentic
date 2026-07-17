/* Curated presentation metadata for the model picker. The daemons discover models live and report only
 * `{ id, label, efforts? }` (ModelSchema), so descriptions and capability badges are curated here by id
 * pattern — first match wins, ordered specific → generic. An unmatched id simply renders label-only, so a
 * brand-new release degrades gracefully until a rule is added. */

export type ModelBadge = "reasoning" | "vision" | "fast" | "agentic";

export interface ModelMetadata {
    readonly description?: string;
    readonly badges?: readonly ModelBadge[];
}

const RULES: readonly { pattern: RegExp; metadata: ModelMetadata }[] = [
    { pattern: /opus/, metadata: { description: `Deepest reasoning, most capable Claude`, badges: [`reasoning`, `vision`] } },
    { pattern: /sonnet/, metadata: { description: `Balanced Claude for everyday coding`, badges: [`reasoning`, `vision`] } },
    { pattern: /haiku/, metadata: { description: `Fastest Claude, light tasks`, badges: [`fast`, `vision`] } },
    { pattern: /codex.*(mini|nano)|(mini|nano).*codex/, metadata: { description: `Smaller, faster Codex`, badges: [`agentic`, `fast`] } },
    { pattern: /codex/, metadata: { description: `OpenAI's agentic coding model`, badges: [`agentic`, `reasoning`] } },
    { pattern: /gpt.*(mini|nano)/, metadata: { description: `Small, fast OpenAI model`, badges: [`fast`] } },
    { pattern: /gpt/, metadata: { description: `OpenAI flagship, general reasoning`, badges: [`reasoning`, `vision`] } },
    { pattern: /grok.*(fast|mini)/, metadata: { description: `Speed-first Grok`, badges: [`fast`] } },
    { pattern: /grok.*code/, metadata: { description: `xAI's coding model`, badges: [`agentic`, `fast`] } },
    { pattern: /grok/, metadata: { description: `xAI frontier model`, badges: [`reasoning`] } },
    { pattern: /fast|mini|nano|lite|flash/, metadata: { badges: [`fast`] } },
];

export const modelMetadataFor = (id: string): ModelMetadata | undefined => {
    const normalized = id.toLowerCase();
    return RULES.find((rule) => rule.pattern.test(normalized))?.metadata;
};
