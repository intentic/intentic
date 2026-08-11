// Legal documents rendered at /privacy and /terms and linked from the platform's sign-in page.
// LEGAL_VERSION is the clickwrap version users accept at sign-in; bump it on any material change
// (intentic-app stamps the accepted version on the user record).
// NOTE: drafted from the code-verified data flows; review by a lawyer before/shortly after go-live.

import { LEGAL_CONTACT_EMAIL, LEGAL_VERSION } from "@intentic/constants";
// Re-exported so this package's existing consumers keep importing them from @intentic-dev/site-content.
export { LEGAL_CONTACT_EMAIL, LEGAL_VERSION };

export interface LegalSection {
    heading: string;
    paragraphs: string[];
    list?: string[];
}

export interface LegalDoc {
    title: string;
    intro: string;
    sections: LegalSection[];
}

export const privacyDoc: LegalDoc = {
    title: "Privacy Policy",
    intro: `Effective ${LEGAL_VERSION}. This policy explains what personal data the intentic platform processes, why, and what rights you have.`,
    sections: [
        {
            heading: "Who we are",
            paragraphs: [
                `The intentic platform (intentic.dev and the hosted workspace app) is operated by Artur Kurowski, established in Poland, acting as the data controller. Contact: ${LEGAL_CONTACT_EMAIL}.`,
            ],
        },
        {
            heading: "What we collect",
            paragraphs: ["The platform stores only your identity and the location of your sandboxes:"],
            list: [
                "Account data: your name, email address, and avatar, received from Google when you sign in.",
                "Session data: a session token plus the IP address and browser user agent of each sign-in, kept for security. Expired sessions are purged automatically.",
                "Sandbox records: sandbox names, their public URLs, and the connection tokens used to reach them.",
                "Teammate emails: addresses you enter when sharing a sandbox, stored so the invitee's account can find it. Unaccepted invitations are purged after 90 days.",
            ],
        },
        {
            heading: "What we do not collect",
            paragraphs: [
                "We run no analytics, no advertising, and no tracking. The only cookie is the strictly necessary session cookie that keeps you signed in.",
                "Your code, infrastructure, credentials for connected services (Cloudflare, GitHub, Forgejo, Anthropic), and everything your agent produces live in your sandbox on your own infrastructure. The platform never stores or reads them.",
            ],
        },
        {
            heading: "Your code and AI",
            paragraphs: [
                "The sandbox runs an AI coding agent powered by Anthropic Claude using your own Anthropic subscription or API key. When you use it, your prompts, workspace files, and command output are sent from your sandbox to Anthropic under your agreement with Anthropic. This traffic does not pass through the platform. Review Anthropic's terms and avoid keeping secrets in the workspace you would not want processed there.",
            ],
        },
        {
            heading: "Who we share data with",
            paragraphs: ["We share personal data only with the processors needed to run the service:"],
            list: [
                "Google: sign-in (Google Identity Services); the app also loads Google Fonts, which discloses your IP address to Google.",
                "Cloudflare: website hosting, DNS, and the tunnels that expose your sandbox.",
                "Anthropic: only via your own sandbox and credentials, as described above.",
            ],
        },
        {
            heading: "Legal bases and international transfers",
            paragraphs: [
                "We process account and sandbox data to perform our contract with you (GDPR Art. 6(1)(b)), and session/security data under our legitimate interest in keeping accounts safe (Art. 6(1)(f)).",
                "Google, Cloudflare, and Anthropic are US-based providers; transfers are covered by the EU–US Data Privacy Framework and/or EU Standard Contractual Clauses under each provider's data processing agreement.",
            ],
        },
        {
            heading: "Retention",
            paragraphs: [
                "Account and sandbox data are kept until you delete your account, which removes them immediately. Expired sessions and stale invitations are purged automatically. The service is free, so there are no billing records to keep.",
            ],
        },
        {
            heading: "Your rights",
            paragraphs: [
                "You can access, correct, export, and erase your data at any time: Settings offers self-service data export and account deletion. You also have the rights to restriction, objection, and portability under the GDPR, and to lodge a complaint with the Polish supervisory authority (UODO, uodo.gov.pl) or your local data protection authority.",
                `For anything else, write to ${LEGAL_CONTACT_EMAIL}.`,
            ],
        },
        {
            heading: "Changes",
            paragraphs: [
                "We will update this policy as the service evolves and change the effective date above. Material changes will be announced in the app.",
            ],
        },
    ],
};

export const termsDoc: LegalDoc = {
    title: "Terms of Service",
    intro: `Effective ${LEGAL_VERSION}. These terms govern your use of the intentic platform. By signing in you agree to them.`,
    sections: [
        {
            heading: "The service",
            paragraphs: [
                "The intentic platform provides accounts and the connection layer between your browser and sandboxes you run on your own infrastructure. It is free of charge, with no paid tier and no usage limits. The intentic software is open source under the MIT license in its entirety, the platform included; these terms cover the hosted service we operate, not your self-hosted components.",
            ],
        },
        {
            heading: "Your account",
            paragraphs: [
                "You sign in with Google and must be legally able to enter this agreement. You are responsible for activity under your account and for keeping access to it secure. One person per account; you may not use the service on behalf of someone you are not authorized to represent.",
            ],
        },
        {
            heading: "Your content and infrastructure",
            paragraphs: [
                "Everything you build stays yours: your code, repositories, and infrastructure run in your own accounts and on your own hosts. You are responsible for what your sandbox and its agent do there, for the costs they incur, and for complying with the terms of the third-party services you connect (Cloudflare, GitHub, Forgejo, Anthropic, and others).",
            ],
        },
        {
            heading: "AI features",
            paragraphs: [
                "The sandbox agent uses Anthropic Claude under your own Anthropic subscription or API key. AI output can be wrong, insecure, or destructive. Review changes before applying them to systems you care about. We are not responsible for the agent's output or for actions you let it take.",
            ],
        },
        {
            heading: "Price",
            paragraphs: [
                "The platform is provided free of charge. We take no payment and process none: any money you spend on running your agents is paid directly to your own model, hosting and infrastructure providers under your agreements with them.",
            ],
        },
        {
            heading: "Acceptable use",
            paragraphs: ["You may not use the platform to:"],
            list: [
                "break the law, infringe others' rights, or distribute malware;",
                "attack, overload, or probe the platform or other users' sandboxes;",
                "resell or provide the platform to third parties as your own service.",
            ],
        },
        {
            heading: "Disclaimers and liability",
            paragraphs: [
                'The platform is provided "as is" and "as available", without warranties of any kind, and is under active development, so features may change or break. Because the service is free of charge, our liability is excluded to the maximum extent permitted by law, and in particular we are not liable for indirect damages, lost data on your own infrastructure, or costs incurred in your third-party accounts. Nothing in these terms limits liability that cannot be limited by law, including your statutory rights as an EU consumer.',
            ],
        },
        {
            heading: "Termination",
            paragraphs: [
                "You can stop using the service and delete your account at any time in Settings. We may suspend or terminate accounts that breach these terms, with notice where reasonable. Sections that by their nature survive (liability, governing law) survive termination.",
            ],
        },
        {
            heading: "Changes and governing law",
            paragraphs: [
                "We may update these terms; material changes will be announced in the app and apply from the stated effective date; continued use after that date means acceptance. These terms are governed by Polish law. EU consumers may also use the European Commission's online dispute resolution platform (ec.europa.eu/consumers/odr).",
                `Contact: ${LEGAL_CONTACT_EMAIL}.`,
            ],
        },
    ],
};
