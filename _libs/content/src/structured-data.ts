import { APP_URL, FOUNDER_NAME, FOUNDER_URL, LOGO_URL, ORG_DESCRIPTION, ORG_NAME, SAME_AS, SITE_URL } from "./site";

const author = { "@type": "Person", name: FOUNDER_NAME, url: FOUNDER_URL } as const;

const publisher = {
    "@type": "Organization",
    name: ORG_NAME,
    logo: { "@type": "ImageObject", url: LOGO_URL, width: 326, height: 326 },
} as const;

export function buildOrganizationSchema() {
    return {
        "@context": "https://schema.org",
        "@type": "Organization",
        "@id": `${SITE_URL}#organization`,
        name: ORG_NAME,
        url: SITE_URL,
        logo: LOGO_URL,
        description: ORG_DESCRIPTION,
        founder: author,
        sameAs: [...SAME_AS],
    };
}

export function buildWebSiteSchema() {
    return {
        "@context": "https://schema.org",
        "@type": "WebSite",
        "@id": `${SITE_URL}#website`,
        url: SITE_URL,
        name: ORG_NAME,
        inLanguage: "en-US",
        publisher: { "@id": `${SITE_URL}#organization` },
    };
}

export function buildWebPageSchema(opts: { name: string; description: string; path: string; datePublished?: string; dateModified?: string }) {
    const url = `${SITE_URL}${opts.path}`;
    return {
        "@context": "https://schema.org",
        "@type": "WebPage",
        "@id": url,
        url,
        name: opts.name,
        description: opts.description,
        inLanguage: "en-US",
        isPartOf: { "@id": `${SITE_URL}#website` },
        publisher,
        ...(opts.datePublished ? { datePublished: opts.datePublished } : {}),
        ...(opts.dateModified ? { dateModified: opts.dateModified } : {}),
    };
}

export function buildFAQPageSchema(opts: { name: string; description: string; path: string; questions: { question: string; answer: string }[] }) {
    const url = `${SITE_URL}${opts.path}`;
    return {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        "@id": `${url}#faq`,
        url,
        name: opts.name,
        description: opts.description,
        inLanguage: "en-US",
        isPartOf: { "@id": `${SITE_URL}#website` },
        mainEntity: opts.questions.map((q) => ({
            "@type": "Question",
            name: q.question,
            acceptedAnswer: { "@type": "Answer", text: q.answer },
        })),
    };
}

export function buildSoftwareAppSchema() {
    return {
        "@context": "https://schema.org",
        "@type": "SoftwareApplication",
        "@id": `${APP_URL}#app`,
        name: ORG_NAME,
        url: APP_URL,
        description: ORG_DESCRIPTION,
        applicationCategory: "DeveloperApplication",
        operatingSystem: "Web",
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD", description: "Free plan: one full sandbox." },
        author,
    };
}
