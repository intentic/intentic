import type { ComplianceReport, DataFlow, Measure, MeasureStatus, PersonalDataReach, ShieldCover } from "@intentic/sandbox-contract";
import { KEY_PROVIDERS } from "../migrations/provider-keys.js";
import type { ComplianceFacts, ConnectorFact } from "./facts.js";
import { PUBLIC_OFFICE_ACTION_KEYS, PUBLIC_OFFICE_ADMISSION_KEYS } from "./preset.js";

// Facts → the data-flow list and the measures checklist. Pure, so the page, the documents and the tests all read the
// same mapping. Hosts and operators are what the code calls (each table names the file it was read from); a region is
// given only where the operator publishes one.

interface Operator {
    readonly operator: string;
    readonly region?: string;
    readonly thirdCountry: boolean;
}

interface Destination extends Operator {
    readonly hosts: readonly string[];
}

// The subscription providers' own hosts (privacy/harness-route.ts, agent/providers/*), and who runs them.
const NATIVE_DESTINATIONS = new Map<string, Destination>([
    ["claude", { hosts: ["api.anthropic.com"], operator: "Anthropic PBC", region: "US", thirdCountry: true }],
    ["codex", { hosts: ["chatgpt.com", "api.openai.com"], operator: "OpenAI", region: "US", thirdCountry: true }],
    ["grok", { hosts: ["api.x.ai"], operator: "xAI", region: "US", thirdCountry: true }],
    ["kimi", { hosts: ["api.kimi.com"], operator: "Moonshot AI", region: "CN", thirdCountry: true }],
    ["meta", { hosts: ["api.meta.ai"], operator: "Meta Platforms", region: "US", thirdCountry: true }],
    ["zai", { hosts: ["api.z.ai"], operator: "Z.ai", thirdCountry: true }],
]);

// An endpoint's operator, known by its host where it is one of the API-key providers the sandbox recognises
// (migrations/provider-keys.ts). Mistral is the one in the EEA.
const KEY_OPERATORS = new Map<string, Operator>([
    ["anthropic", { operator: "Anthropic PBC", region: "US", thirdCountry: true }],
    ["openai", { operator: "OpenAI", region: "US", thirdCountry: true }],
    ["openrouter", { operator: "OpenRouter", region: "US", thirdCountry: true }],
    ["gemini", { operator: "Google", region: "US", thirdCountry: true }],
    ["xai", { operator: "xAI", region: "US", thirdCountry: true }],
    ["deepseek", { operator: "DeepSeek", region: "CN", thirdCountry: true }],
    ["groq", { operator: "Groq", region: "US", thirdCountry: true }],
    ["mistral", { operator: "Mistral AI", region: "EU", thirdCountry: false }],
    ["moonshot", { operator: "Moonshot AI", region: "CN", thirdCountry: true }],
]);

// Team-chat gateways (_extensions/{discord,slack,telegram,whatsapp}).
const TEAM_CHAT_DESTINATIONS = new Map<string, Destination>([
    ["discord", { hosts: ["discord.com", "gateway.discord.gg", "cdn.discordapp.com"], operator: "Discord Inc.", region: "US", thirdCountry: true }],
    ["slack", { hosts: ["slack.com", "wss-primary.slack.com", "files.slack.com"], operator: "Slack Technologies (Salesforce)", region: "US", thirdCountry: true }],
    ["telegram", { hosts: ["api.telegram.org"], operator: "Telegram", thirdCountry: true }],
    ["whatsapp", { hosts: ["web.whatsapp.com", "g.whatsapp.net"], operator: "WhatsApp Ireland (Meta)", region: "EU/US", thirdCountry: true }],
]);

// Cloud voices (speech/voice/cloud-voices.ts). Speech recognition is always local, so it has no row.
const SPEECH_DESTINATIONS = new Map<string, Destination>([
    ["elevenlabs", { hosts: ["api.elevenlabs.io"], operator: "ElevenLabs", region: "US", thirdCountry: true }],
    ["cartesia", { hosts: ["api.cartesia.ai"], operator: "Cartesia", region: "US", thirdCountry: true }],
    ["deepgram", { hosts: ["api.deepgram.com"], operator: "Deepgram", region: "US", thirdCountry: true }],
]);

const MAIL_IN = new Set(["imap"]);
// Lane-neutral: whichever connector sends mail names itself one of these.
const MAIL_OUT = new Set(["smtp", "email", "email-send"]);

// The edge the Intentic tunnel ends at (_platform/ingress); where TLS for a tunnelled sandbox terminates.
const INTENTIC_EDGE_ZONE = "sbx.intentic.dev";

const hostOf = (url: string | undefined): string | undefined => {
    if (url === undefined || url === "") {
        return undefined;
    }
    try {
        return new URL(url).hostname;
    } catch {
        // allow(silent-catch): a value that is not an address names no host to list.
        return undefined;
    }
};

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0", "host.docker.internal"]);

// What the shield does for a model provider: trusted ones read values, the rest read tokens, and a runtime the shield
// cannot read is refused rather than sent unmasked.
const modelShield = (facts: ComplianceFacts, provider: { readonly id: string; readonly local: boolean; readonly shieldable: boolean }): ShieldCover => {
    if (provider.local) {
        return "local";
    }
    if (facts.privacy.mode === "off") {
        return "none";
    }
    if (facts.privacy.mode === "watch") {
        return "watched";
    }
    if (facts.privacy.trusted.includes(provider.id)) {
        return "trusted";
    }
    return provider.shieldable ? "masked" : "blocked";
};

const modelFlows = (facts: ComplianceFacts): DataFlow[] =>
    facts.providers
        .filter((provider) => provider.connected)
        .map((provider): DataFlow => {
            const endpointId = provider.id.startsWith("endpoint/") ? provider.id.slice("endpoint/".length) : undefined;
            const endpoint = facts.endpoints.find((entry) => entry.id === endpointId);
            const shield = modelShield(facts, provider);
            const base = { group: "models" as const, name: provider.label, active: true, personalData: "yes" as const, shield, switch: "privacy" };
            if (endpoint === undefined) {
                const destination = NATIVE_DESTINATIONS.get(provider.id);
                return {
                    ...base,
                    id: `model-provider:${provider.id}`,
                    kind: "model-provider",
                    hosts: [...(destination?.hosts ?? [])],
                    operator: destination?.operator,
                    region: destination?.region,
                    thirdCountry: destination?.thirdCountry ?? true,
                };
            }
            const host = hostOf(endpoint.baseUrl);
            if (provider.local || endpoint.kind === "localmodel" || (host !== undefined && LOCAL_HOSTS.has(host))) {
                return { ...base, id: `local-model:${endpoint.id}`, kind: "local-model", hosts: host === undefined ? [] : [host], region: "this machine", thirdCountry: false };
            }
            const known = KEY_PROVIDERS.find((entry) => hostOf(entry.baseUrl) === host);
            const operator = known === undefined ? undefined : KEY_OPERATORS.get(known.id);
            return {
                ...base,
                id: `model-endpoint:${endpoint.id}`,
                kind: "model-endpoint",
                hosts: host === undefined ? [] : [host],
                operator: operator?.operator,
                region: operator?.region,
                thirdCountry: operator?.thirdCountry,
                question: operator === undefined ? "endpoint-operator" : undefined,
            };
        });

// The IMAP card sends too once its SMTP host is filled in (each send held for approval unless the owner allows it),
// which is a second way out with a server of its own.
const sendingFlow = (connector: ConnectorFact): DataFlow[] =>
    MAIL_IN.has(connector.provider) && connector.smtpHost !== undefined && connector.smtpHost !== ""
        ? [
              {
                  id: `email-smtp:${connector.id}`,
                  group: "messaging",
                  kind: "email-smtp",
                  name: connector.id,
                  hosts: [connector.smtpHost],
                  active: true,
                  personalData: "yes",
                  shield: "none",
                  switch: "actionRules",
                  question: "mail-operator",
              },
          ]
        : [];

const connectorFlow = (connector: ConnectorFact): DataFlow => {
    const chat = TEAM_CHAT_DESTINATIONS.get(connector.provider);
    if (chat !== undefined) {
        return {
            id: `team-chat:${connector.id}`,
            group: "messaging",
            kind: "team-chat",
            name: connector.provider,
            hosts: [...chat.hosts],
            operator: chat.operator,
            region: chat.region,
            thirdCountry: chat.thirdCountry,
            active: true,
            personalData: "yes",
            shield: "none",
            switch: "actionRules",
        };
    }
    const mailHost = connector.host === undefined || connector.host === "" ? [] : [connector.host];
    if (MAIL_IN.has(connector.provider)) {
        return {
            id: `email-imap:${connector.id}`,
            group: "messaging",
            kind: "email-imap",
            name: connector.id,
            hosts: mailHost,
            active: true,
            personalData: "yes",
            shield: "none",
            switch: "capabilities",
            question: "mail-operator",
        };
    }
    if (MAIL_OUT.has(connector.provider)) {
        return {
            id: `email-smtp:${connector.id}`,
            group: "messaging",
            kind: "email-smtp",
            name: connector.id,
            hosts: mailHost,
            active: true,
            personalData: "yes",
            shield: "none",
            switch: "actionRules",
            question: "mail-operator",
        };
    }
    return {
        id: `connector:${connector.id}`,
        group: "connectors",
        kind: "connector",
        name: connector.provider,
        hosts: [...connector.hosts],
        active: true,
        personalData: "possible",
        shield: "none",
        switch: "capabilities",
    };
};

// Through the tunnel the open question is where Intentic's edge runs; with neither a tunnel nor an address of the
// office's own, it is how the sandbox is reached at all.
const ingressQuestion = (tunnel: boolean, ownProxy: boolean): string | undefined => {
    if (tunnel) {
        return "ingress-region";
    }
    return ownProxy ? undefined : "ingress-proxy";
};

// How a self-hosted sandbox is reached: through Intentic's tunnel (TLS ends on Intentic's edge on Fly.io), through an
// address of the office's own (its reverse proxy), or the sandbox cannot tell.
const ingressFlow = (facts: ComplianceFacts): DataFlow => {
    const publicHost = hostOf(facts.ingress.publicUrl);
    const tunnel = facts.ingress.by === "tunnel";
    const ownProxy = !tunnel && publicHost !== undefined && !publicHost.endsWith(INTENTIC_EDGE_ZONE);
    return {
        id: "ingress",
        group: "platform",
        kind: "ingress",
        name: tunnel ? "Intentic ingress" : ownProxy ? publicHost : "ingress",
        hosts: tunnel ? [hostOf(facts.ingress.ingressUrl) ?? `ingress.${INTENTIC_EDGE_ZONE}`] : publicHost === undefined ? [] : [publicHost],
        operator: tunnel ? "Intentic (Fly.io)" : undefined,
        // Where Intentic's sub-processors page puts the edge (one machine in Ashburn, Virginia, on 2026-10-13). The
        // sandbox cannot see which edge machine a browser lands on, so the office is still asked to confirm it.
        region: tunnel ? "US" : undefined,
        thirdCountry: tunnel ? true : undefined,
        active: tunnel || ownProxy,
        personalData: "yes",
        shield: "none",
        switch: "INGRESS_URL",
        question: ingressQuestion(tunnel, ownProxy),
    };
};

export const flowsOf = (facts: ComplianceFacts): DataFlow[] => {
    const anyModel = facts.providers.some((provider) => provider.connected);
    const enabledChats = facts.webchats.filter((chat) => chat.enabled);
    const localModels = facts.endpoints.filter((entry) => entry.kind === "localmodel");
    const speech = facts.speechCloud === undefined ? undefined : SPEECH_DESTINATIONS.get(facts.speechCloud);
    const pushShield: ShieldCover = facts.privacy.mode === "on" ? "masked" : "none";
    const webPersonal: PersonalDataReach = "possible";
    return [
        ...modelFlows(facts),
        ...facts.connectors.flatMap((connector) => [connectorFlow(connector), ...sendingFlow(connector)]),
        {
            id: "webchat",
            group: "messaging",
            kind: "webchat",
            name: "web chat",
            hosts: [
                ...(hostOf(facts.ingress.publicUrl) === undefined ? [] : [hostOf(facts.ingress.publicUrl) ?? ""]),
                ...(enabledChats.some((chat) => chat.turnstile) ? ["challenges.cloudflare.com"] : []),
                ...(enabledChats.some((chat) => chat.googleSignIn) ? ["www.googleapis.com"] : []),
            ],
            active: enabledChats.length > 0,
            personalData: "yes",
            shield: "none",
            switch: "admission.webchat",
        },
        ...(facts.speechCloud === undefined
            ? []
            : [
                  {
                      id: `speech:${facts.speechCloud}`,
                      group: "speech" as const,
                      kind: "speech" as const,
                      name: facts.speechCloud,
                      hosts: [...(speech?.hosts ?? [])],
                      operator: speech?.operator,
                      region: speech?.region,
                      thirdCountry: speech?.thirdCountry ?? true,
                      active: true,
                      personalData: "yes" as const,
                      shield: "none" as const,
                      switch: "voice.cloud",
                  },
              ]),
        // Search runs as the model provider's own tool, so the query rides the provider's traffic, unmasked.
        { id: "web-search", group: "web", kind: "web-search", name: "web search", hosts: [], active: anyModel, personalData: webPersonal, shield: "none" },
        { id: "web-fetch", group: "web", kind: "web-fetch", name: "web pages", hosts: [], active: anyModel, personalData: webPersonal, shield: "none", switch: "actionRules" },
        { id: "browser", group: "web", kind: "browser", name: "browser", hosts: [], active: true, personalData: webPersonal, shield: "none" },
        {
            id: "platform-link",
            group: "platform",
            kind: "platform-link",
            name: "Intentic",
            hosts: [hostOf(facts.platform.url) ?? "app.intentic.dev"],
            operator: "Intentic",
            active: facts.platform.url !== "" && facts.platform.state !== "off",
            // Members sign in through the platform, so their account addresses travel; the work itself does not.
            personalData: "yes",
            shield: "none",
            switch: "PLATFORM_URL",
            question: "platform-region",
        },
        ingressFlow(facts),
        {
            id: "push",
            group: "platform",
            kind: "push-notifications",
            name: "push",
            hosts: ["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com"],
            active: facts.pushChannels > 0,
            thirdCountry: true,
            personalData: "possible",
            shield: pushShield,
        },
        {
            id: "update-check",
            group: "maintenance",
            kind: "update-check",
            name: "GitHub",
            hosts: ["api.github.com", "ghcr.io", "raw.githubusercontent.com", "registry.npmjs.org"],
            operator: "GitHub (Microsoft)",
            region: "US",
            thirdCountry: true,
            active: facts.updateChecks,
            personalData: "no",
            shield: "none",
        },
        {
            id: "model-download",
            group: "maintenance",
            kind: "model-download",
            name: "Hugging Face",
            hosts: ["huggingface.co", "github.com"],
            operator: "Hugging Face",
            region: "US",
            thirdCountry: true,
            active: localModels.length > 0 || facts.readers.model || facts.readers.ocr,
            personalData: "no",
            shield: "none",
        },
        {
            id: "product-analytics",
            group: "analytics",
            kind: "product-analytics",
            name: "PostHog",
            hosts: ["us.i.posthog.com", "us-assets.i.posthog.com"],
            operator: "PostHog Inc.",
            region: "US",
            thirdCountry: true,
            active: facts.settings.productAnalytics,
            personalData: "yes",
            shield: "none",
            switch: "productAnalytics",
        },
    ];
};

// How much of a list of rules stands at hold or stricter: all of it, some, or none.
const coverage = (count: number, of: number): MeasureStatus => (count === 0 ? "off" : count >= of ? "on" : "partial");

const shieldOff = (facts: ComplianceFacts): boolean => facts.privacy.mode === "off";

// off/watch/on, read the same way for the shield and the safety judge: watching records without stopping anything.
const MODE_STATUS = { off: "off", watch: "partial", on: "on" } as const satisfies Record<string, MeasureStatus>;
const modeStatus = (mode: keyof typeof MODE_STATUS): MeasureStatus => MODE_STATUS[mode];

const switched = (on: boolean): MeasureStatus => (on ? "on" : "off");

const imagesStatus = (facts: ComplianceFacts): MeasureStatus => {
    if (shieldOff(facts) || facts.privacy.images === "allow") {
        return "off";
    }
    return facts.readers.ocr ? "on" : "partial";
};

const namesStatus = (facts: ComplianceFacts): MeasureStatus => {
    if (shieldOff(facts)) {
        return "off";
    }
    return facts.privacy.names === "model" && facts.readers.model ? "on" : "partial";
};

const trustedStatus = (facts: ComplianceFacts): MeasureStatus => {
    if (shieldOff(facts)) {
        return "off";
    }
    return facts.privacy.trusted.length === 0 ? "on" : "partial";
};

const privacyMeasures = (facts: ComplianceFacts): Measure[] => {
    const { privacy } = facts;
    const localConnected = facts.providers.filter((provider) => provider.connected && provider.local).length;
    return [
        { id: "privacy-shield", category: "confidentiality", status: modeStatus(privacy.mode), facts: { mode: privacy.mode, classes: privacy.classes.length }, preset: true },
        { id: "privacy-images", category: "confidentiality", status: imagesStatus(facts), facts: { images: privacy.images, ocr: facts.readers.ocr }, preset: true },
        { id: "privacy-names", category: "confidentiality", status: namesStatus(facts), facts: { names: privacy.names, model: facts.readers.model }, preset: true },
        {
            id: "trusted-providers",
            category: "confidentiality",
            status: trustedStatus(facts),
            facts: { trusted: privacy.trusted.length, conversations: privacy.conversations.length },
            preset: false,
        },
        { id: "local-models", category: "minimisation", status: switched(localConnected > 0), facts: { local: localConnected }, preset: false },
    ];
};

const accessMeasures = (facts: ComplianceFacts): Measure[] => [
    { id: "member-roles", category: "confidentiality", status: "on", facts: { members: facts.members.total, guests: facts.members.guests }, preset: false },
    { id: "areas", category: "confidentiality", status: switched(facts.members.fenced > 0), facts: { areas: facts.areas, fenced: facts.members.fenced }, preset: false },
    { id: "guest-jail", category: "confidentiality", status: "on", facts: { guests: facts.members.guests }, preset: false },
    { id: "sign-in", category: "confidentiality", status: "on", facts: { emailSignIn: facts.members.emailSignIn }, preset: false },
    { id: "credential-gates", category: "confidentiality", status: switched(facts.credentialGates > 0), facts: { gates: facts.credentialGates }, preset: false },
    { id: "host-guards", category: "confidentiality", status: switched(facts.hostGuards > 0), facts: { guards: facts.hostGuards }, preset: false },
    { id: "encryption-at-rest", category: "confidentiality", status: switched(facts.atRestKey), facts: { key: facts.atRestKey }, preset: false },
    {
        id: "encryption-in-transit",
        category: "confidentiality",
        // Through the tunnel every connection is TLS to Intentic's edge; behind the office's own proxy, the proxy decides.
        status: facts.ingress.by === "tunnel" ? "on" : "unknown",
        facts: { by: facts.ingress.by },
        preset: false,
    },
];

const controlMeasures = (facts: ComplianceFacts): Measure[] => {
    const { settings } = facts;
    const actionHeld = PUBLIC_OFFICE_ACTION_KEYS.filter((key) => {
        const rule = settings.actionRules[key] ?? settings.actionRules[`${key.split(".")[0] ?? key}.*`];
        return rule === "hold" || rule === "deny";
    }).length;
    const admissionHeld = PUBLIC_OFFICE_ADMISSION_KEYS.filter((key) => settings.admission[key] !== "allow").length;
    return [
        {
            id: "action-rules",
            category: "integrity",
            status: coverage(actionHeld, PUBLIC_OFFICE_ACTION_KEYS.length),
            facts: { held: actionHeld, of: PUBLIC_OFFICE_ACTION_KEYS.length },
            preset: true,
        },
        {
            id: "admission",
            category: "integrity",
            status: coverage(admissionHeld, PUBLIC_OFFICE_ADMISSION_KEYS.length),
            facts: { held: admissionHeld, of: PUBLIC_OFFICE_ADMISSION_KEYS.length },
            preset: true,
        },
        { id: "command-judge", category: "integrity", status: modeStatus(settings.commandJudge), facts: { mode: settings.commandJudge }, preset: true },
        { id: "agent-domain", category: "integrity", status: switched(facts.agentDomain === "unprivileged"), facts: { domain: facts.agentDomain }, preset: false },
    ];
};

const recordMeasures = (facts: ComplianceFacts): Measure[] => {
    const { settings } = facts;
    const retention = Object.values(settings.retention);
    return [
        {
            id: "retention",
            category: "minimisation",
            status: coverage(retention.filter((days) => days > 0).length, retention.length),
            facts: { ...settings.retention },
            preset: true,
        },
        { id: "audit", category: "accountability", status: "on", facts: { retentionDays: settings.audit.retentionDays }, preset: true },
        { id: "audit-reads", category: "accountability", status: switched(settings.audit.recordReads), facts: { recordReads: settings.audit.recordReads }, preset: true },
        { id: "audit-forward", category: "accountability", status: switched(settings.audit.forwardUrl !== ""), facts: { forward: settings.audit.forwardUrl !== "" }, preset: false },
        { id: "backups", category: "availability", status: "unknown", facts: {}, preset: false },
    ];
};

const transparencyMeasures = (facts: ComplianceFacts): Measure[] => {
    const { settings } = facts;
    const chats = facts.webchats.filter((chat) => chat.enabled);
    const disclosed = chats.filter((chat) => chat.aiDisclosure).length;
    return [
        { id: "product-analytics", category: "minimisation", status: switched(!settings.productAnalytics), facts: { analytics: settings.productAnalytics }, preset: true },
        { id: "ai-notice", category: "transparency", status: switched(settings.aiNotice.show), facts: { show: settings.aiNotice.show }, preset: true },
        {
            id: "webchat-ai-disclosure",
            category: "transparency",
            // No web chat answers anyone, so nobody goes untold.
            status: chats.length === 0 ? "on" : coverage(disclosed, chats.length),
            facts: { webchats: chats.length, disclosed },
            preset: false,
        },
    ];
};

export const measuresOf = (facts: ComplianceFacts): Measure[] => [
    ...privacyMeasures(facts),
    ...accessMeasures(facts),
    ...controlMeasures(facts),
    ...recordMeasures(facts),
    ...transparencyMeasures(facts),
];

export const reportOf = (facts: ComplianceFacts, now: Date = new Date()): ComplianceReport => ({
    generatedAt: now.toISOString(),
    flows: flowsOf(facts),
    measures: measuresOf(facts),
});
