/* Curated presentation metadata for the model picker. The daemons discover models live and report only
 * `{ id, label, efforts? }` (ModelSchema), so descriptions and capability badges are curated here by id
 * pattern — first match wins, ordered specific → generic. An unmatched id simply renders label-only, so a
 * brand-new release degrades gracefully until a rule is added. */

export type ModelBadge = "reasoning" | "vision" | "fast" | "agentic";

export interface ModelMetadata {
    readonly description?: string;
    readonly badges?: readonly ModelBadge[];
    // Relative capability, strongest-first — the picker sorts each provider's models by this (a version number
    // breaks ties, so within a tier the newest generation leads). Only ever compared WITHIN one provider, so the
    // scale is coarse: FLAGSHIP (deepest) > BALANCED (everyday) > CODING (specialized) > FAST (light/small).
    readonly rank?: number;
}

// The coarse capability tiers `rank` draws from. Compared only within a provider, so absolute values are
// arbitrary — only the ordering FLAGSHIP > BALANCED > CODING > FAST matters. An id matching no rule below
// renders rankless and the picker floors it just under BALANCED (a new flagship surfaces rather than sinks).
const FLAGSHIP = 90;
const BALANCED = 80;
const CODING = 65;
const FAST = 50;

const RULES: readonly { pattern: RegExp; metadata: ModelMetadata }[] = [
    { pattern: /opus/, metadata: { description: `Deepest reasoning, most capable Claude`, badges: [`reasoning`, `vision`], rank: FLAGSHIP } },
    { pattern: /sonnet/, metadata: { description: `Balanced Claude for everyday coding`, badges: [`reasoning`, `vision`], rank: BALANCED } },
    { pattern: /haiku/, metadata: { description: `Fastest Claude, light tasks`, badges: [`fast`, `vision`], rank: FAST } },
    { pattern: /codex.*(mini|nano)|(mini|nano).*codex/, metadata: { description: `Smaller, faster Codex`, badges: [`agentic`, `fast`], rank: FAST } },
    { pattern: /codex/, metadata: { description: `OpenAI's agentic coding model`, badges: [`agentic`, `reasoning`], rank: CODING } },
    { pattern: /gpt.*(mini|nano)/, metadata: { description: `Small, fast OpenAI model`, badges: [`fast`], rank: FAST } },
    { pattern: /gpt/, metadata: { description: `OpenAI flagship, general reasoning`, badges: [`reasoning`, `vision`], rank: FLAGSHIP } },
    { pattern: /grok.*(fast|mini)/, metadata: { description: `Speed-first Grok`, badges: [`fast`], rank: FAST } },
    { pattern: /grok.*code/, metadata: { description: `xAI's coding model`, badges: [`agentic`, `fast`], rank: CODING } },
    { pattern: /grok/, metadata: { description: `xAI frontier model`, badges: [`reasoning`], rank: FLAGSHIP } },
    { pattern: /fast|mini|nano|lite|flash/, metadata: { badges: [`fast`], rank: FAST } },
];

export const modelMetadataFor = (id: string): ModelMetadata | undefined => {
    const normalized = id.toLowerCase();
    return RULES.find((rule) => rule.pattern.test(normalized))?.metadata;
};
