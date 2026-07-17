export interface PageMeta {
    title: string;
    description: string;
    datePublished: string;
}

export const pageMeta: Record<string, PageMeta> = {
    "/": {
        title: "intentic — Build software with intent",
        description:
            "An AI-native workspace for infra, data, apps, and code. Your agent runs on your machine — the platform can't read your code or secrets. Capabilities, automations, team sandboxes, and an open-source engine that self-hosts your infrastructure. Free to start.",
        datePublished: "2026-07-06",
    },
    "/privacy/": {
        title: "Privacy Policy — intentic",
        description: "What personal data the intentic platform processes, why, who it is shared with, and your rights under the GDPR.",
        datePublished: "2026-07-03",
    },
    "/terms/": {
        title: "Terms of Service — intentic",
        description: "The terms governing use of the intentic platform: accounts, billing, acceptable use, and liability.",
        datePublished: "2026-07-03",
    },
};

function normalize(path: string): string {
    return path.endsWith("/") ? path : `${path}/`;
}

export function getPageMeta(path: string): PageMeta | undefined {
    return pageMeta[normalize(path)];
}
