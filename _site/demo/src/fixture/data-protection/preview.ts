import type { PersonalDataClass, PrivacyPreview, PrivacyShieldPolicy } from "@intentic/sandbox-contract/schemas/privacy";

// The shield's "try it" box: what it would mask in a typed text, found the way the daemon's detectors find it (patterns
// for the shaped data, name lists for people), limited to the classes the policy looks for. A short list of names
// stands in for the registers the daemon reads.

const DETECTORS: readonly (readonly [PersonalDataClass, RegExp])[] = [
    [`email`, /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gu],
    [`bank-account`, /\b[A-Z]{2}\d{2}(?: ?\d{4}){4,7}\b/gu],
    [`payment-card`, /\b(?:\d{4}[ -]?){3}\d{4}\b/gu],
    [`national-id`, /\b\d{11}\b/gu],
    [`tax-id`, /\b\d{3}-\d{3}-\d{2}-\d{2}\b/gu],
    [`phone`, /(?:\+\d{2} ?)?\b\d{3}[ -]\d{3}[ -]\d{3}\b/gu],
    [`address`, /\b(?:ul\.|ulica|street|st\.) [\p{Lu}][\p{L}-]+ \d+\w?/giu],
];

const NAMES = new Set(
    `anna maria katarzyna małgorzata agnieszka jan andrzej piotr krzysztof tomasz paweł michał kasia ada grace alan lin jo nowak kowalski kowalska wiśniewski wójcik kamiński lewandowski zieliński lovelace turing hopper`.split(
        ` `,
    ),
);

const overlaps = (spans: PrivacyPreview[`spans`], start: number, end: number): boolean => spans.some((span) => start < span.end && end > span.start);

export const previewText = (text: string, policy: PrivacyShieldPolicy): PrivacyPreview => {
    const spans: PrivacyPreview[`spans`] = [];
    for (const [kind, pattern] of DETECTORS.filter(([wanted]) => policy.classes.includes(wanted))) {
        for (const match of text.matchAll(pattern)) {
            const start = match.index;
            const end = start + match[0].length;
            if (!overlaps(spans, start, end)) {
                spans.push({ start, end, class: kind, by: `detector` });
            }
        }
    }
    if (policy.classes.includes(`person-name`)) {
        for (const match of text.matchAll(/\p{Lu}\p{Ll}+/gu)) {
            const start = match.index;
            const end = start + match[0].length;
            if (NAMES.has(match[0].toLowerCase()) && !overlaps(spans, start, end)) {
                spans.push({ start, end, class: `person-name`, by: `detector` });
            }
        }
    }
    return { spans: spans.toSorted((left, right) => left.start - right.start) };
};
