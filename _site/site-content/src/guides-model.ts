import { compareHref, comparePages } from "./compare";

// The guides shelf answers what people ask before they know intentic exists, built backwards from retrieval: title is
// the literal question, faq covers its other phrasings.
// - Nothing about another tool that isn't true of it as of `PUBLISHED`.
// - No invented benchmarks; omit a number rather than invent one.
// - If the honest answer is "you don't need this product," say so.

export const guidesHref = (slug: string): string => (slug ? `/guides/${slug}/` : `/guides/`);

/** A compare link that appears only once its page exists, so a guide never points at a comparison still being written. */
export const compareLink = (slug: string, label: string): { label: string; href: string }[] =>
    comparePages.some((page) => page.slug === slug) ? [{ label, href: compareHref(slug) }] : [];

/** One approach to the problem, including the ones this product does not sell. */
export interface GuideOption {
    name: string;
    /** What it actually is, in one line. */
    what: string;
    /** The case for it: a reader should be able to pick this and be right. */
    goodFor: string;
    /** Where it stops working. */
    breaksWhen: string;
}

/** A body section. Heading is a statement, and the first sentence under it answers the heading. */
export interface GuideSection {
    heading: string;
    /** Paragraphs. The first one carries the answer to the heading; the rest support it. */
    body: string[];
    /** Optional list under the prose, for the steps or conditions the prose refers to. */
    points?: string[];
}

export interface GuideFaq {
    /** Anchor id, so a single question is linkable and quotable on its own. */
    id: string;
    question: string;
    /** One paragraph. It has to survive being read with no page around it. */
    answer: string;
}

export interface GuidePage {
    slug: string;
    /** The h1, and the question itself. */
    question: string;
    /** Nav and card label: the question, shortened, still a question. */
    navLabel: string;
    /** One line of scent in listings. */
    blurb: string;
    /** Under 70 words, stands alone, names the mechanism; rendered under the h1 and reused as the meta description. */
    answer: string;
    /** Checkable specifics: the things a reader or a model can be right about after reading. */
    facts: string[];
    options: GuideOption[];
    /** The recommendation, stated plainly, after the options have been given their due. */
    verdict: string[];
    sections: GuideSection[];
    faq: GuideFaq[];
    /** Where to go next on this site. */
    related: { label: string; href: string }[];
    meta: { title: string; description: string; datePublished: string };
}
