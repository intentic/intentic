import { accessSync, constants } from "node:fs";
import { z } from "zod";
import { AT_REST_KEY_FILE_ENV } from "@intentic/sandbox-contract/schemas/data-protection";
import type { AgentDomainPolicy, SandboxSettings } from "@intentic/sandbox-contract/schemas/settings";
import type { AnnounceState } from "@intentic/sandbox-contract/schemas/platform-link";
import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import type { PrivacyProvider, PrivacyShieldPolicy } from "@intentic/sandbox-contract/schemas/privacy";
import type { SecretHostGuard } from "@intentic/sandbox-contract/schemas/secrets";
import type { Services } from "../composition.js";
import { providerReadiness } from "../agent/providers/provider-registry.js";
import { profileTraits } from "../system/boot/profile.js";
import { reachPosture } from "../system/listeners/reach-posture.js";
import { privacyProviders } from "../privacy/privacy-trust.js";
import { isDevBuild } from "../version.js";

// Everything the data protection page and its documents say about this sandbox, read once from the live services as
// plain data. The mapping to flows, measures and documents (report.ts, documents.ts) reads only this, so a test hands
// it a representative sandbox without standing one up.

export interface ConnectorFact {
    readonly id: string;
    // The connector's own name (`github`, `discord`, `imap`), as the card's provider field says.
    readonly provider: string;
    // The hosts its credential may be spent on, from its host guard; empty when no guard names any.
    readonly hosts: readonly string[];
    readonly guarded: boolean;
    // For mail: the server, from the card's own field.
    readonly host: string | undefined;
    // For a mail card that can also send (the IMAP card's SMTP fields): the outgoing server.
    readonly smtpHost?: string | undefined;
}

export interface EndpointFact {
    readonly id: string;
    readonly kind: "endpoint" | "localmodel";
    // Where it is reached; a local model the daemon serves itself has none of its own.
    readonly baseUrl: string | undefined;
    readonly model: string | undefined;
}

export interface WebchatFact {
    readonly id: string;
    readonly enabled: boolean;
    // AI Act Art. 50(1): absent on the card means the disclosure is shown.
    readonly aiDisclosure: boolean;
    readonly turnstile: boolean;
    readonly googleSignIn: boolean;
}

export interface MemberFacts {
    readonly total: number;
    readonly guests: number;
    // Members held to some areas of the workspace rather than all of it.
    readonly fenced: number;
    // Members who may sign in with an emailed code rather than Google, a passkey or a recovery code.
    readonly emailSignIn: number;
}

export interface ComplianceFacts {
    readonly settings: SandboxSettings;
    readonly privacy: PrivacyShieldPolicy;
    readonly readers: { readonly ocr: boolean; readonly model: boolean };
    // Every provider a turn could run on, with whether it is connected now.
    readonly providers: readonly (PrivacyProvider & { readonly connected: boolean })[];
    // Endpoints and local models by id, with the address they are reached at.
    readonly endpoints: readonly EndpointFact[];
    readonly connectors: readonly ConnectorFact[];
    // Team-chat connectors that an automation listens on.
    readonly listening: readonly string[];
    readonly webchats: readonly WebchatFact[];
    readonly browsers: number;
    // The cloud voice provider replies are spoken by, when one is connected.
    readonly speechCloud: string | undefined;
    readonly platform: { readonly url: string; readonly state: AnnounceState["state"] };
    readonly ingress: { readonly by: "tunnel" | "loopback"; readonly ingressUrl: string; readonly publicUrl: string };
    readonly updateChecks: boolean;
    readonly pushChannels: number;
    readonly members: MemberFacts;
    readonly areas: number;
    readonly agentDomain: AgentDomainPolicy["agentDomain"];
    readonly credentialGates: number;
    readonly hostGuards: number;
    // Whether the key file the at-rest encryption reads (AT_REST_KEY_FILE_ENV) is set and readable.
    readonly atRestKey: boolean;
    readonly version: string;
}

export const atRestKeyReadable = (env: NodeJS.ProcessEnv = process.env): boolean => {
    const path = env[AT_REST_KEY_FILE_ENV];
    if (path === undefined || path.trim() === "") {
        return false;
    }
    try {
        accessSync(path, constants.R_OK);
        return true;
    } catch {
        // allow(silent-catch): an unreadable key file is exactly what `false` reports.
        return false;
    }
};

const TEAM_CHAT = new Set(["discord", "slack", "telegram", "whatsapp"]);

// A connector card's own fields are whatever its connector declares; these two are the ones this page reads.
const ConnectorFieldsSchema = z.looseObject({ provider: z.string().optional(), host: z.string().optional(), smtpHost: z.string().optional() });

const connectorsOf = (capabilities: readonly Capability[], guards: readonly SecretHostGuard[]): ConnectorFact[] =>
    capabilities.flatMap((capability): ConnectorFact[] => {
        if (capability.kind !== "cli" && capability.kind !== "mcp") {
            return [];
        }
        const guard = guards.find((entry) => entry.subject === capability.id);
        const fields = ConnectorFieldsSchema.safeParse(capability.config);
        return [
            {
                id: capability.id,
                provider: (fields.success ? fields.data.provider : undefined) ?? capability.id,
                hosts: guard?.hosts ?? [],
                guarded: guard?.guard ?? false,
                host: fields.success ? fields.data.host : undefined,
                smtpHost: fields.success ? fields.data.smtpHost : undefined,
            },
        ];
    });

const endpointsOf = (capabilities: readonly Capability[]): EndpointFact[] =>
    capabilities.flatMap((capability): EndpointFact[] => {
        if (capability.kind === "endpoint") {
            return [{ id: capability.id, kind: "endpoint", baseUrl: capability.config.baseUrl, model: undefined }];
        }
        if (capability.kind === "localmodel") {
            return [{ id: capability.id, kind: "localmodel", baseUrl: capability.config.url, model: capability.config.model }];
        }
        return [];
    });

export type FactsServices = Pick<
    Services,
    | "sandboxSettings"
    | "privacyShield"
    | "capabilities"
    | "hostGuards"
    | "credentialGates"
    | "automations"
    | "announcer"
    | "config"
    | "push"
    | "members"
    | "areas"
    | "agentDomainPolicy"
    | "info"
> &
    Parameters<typeof providerReadiness>[0];

export const gatherFacts = async (services: FactsServices): Promise<ComplianceFacts> => {
    const [settings, status, capabilities, guards, gates, automations, channels, members, areas, domain, ready] = await Promise.all([
        services.sandboxSettings.get(),
        services.privacyShield.status(),
        services.capabilities.list(),
        services.hostGuards(),
        services.credentialGates.list(),
        services.automations.list(),
        services.push.list(),
        services.members.list(),
        services.areas.list(),
        services.agentDomainPolicy.get(),
        providerReadiness(services),
    ]);
    const endpointIds = new Set(capabilities.filter((entry) => entry.kind === "endpoint" || entry.kind === "localmodel").map((entry) => `endpoint/${entry.id}`));
    const readyIds = new Set(Object.entries(ready).flatMap(([id, connected]) => (connected ? [id] : [])));
    const providers = privacyProviders(capabilities).map((provider) => ({
        ...provider,
        connected: endpointIds.has(provider.id) || readyIds.has(provider.id),
    }));
    const listeners = automations.filter((automation) => automation.enabled && automation.trigger.kind === "listener");
    const config = services.config;
    return {
        settings,
        privacy: status.policy,
        readers: status.readers,
        providers,
        endpoints: endpointsOf(capabilities),
        connectors: connectorsOf(capabilities, guards),
        listening: [
            ...new Set(
                listeners.flatMap((automation) =>
                    automation.trigger.kind === "listener" && TEAM_CHAT.has(automation.trigger.provider) ? [automation.trigger.provider] : [],
                ),
            ),
        ],
        webchats: automations.flatMap((automation): WebchatFact[] =>
            automation.trigger.kind === "listener" && automation.trigger.provider === "webchat"
                ? [
                      {
                          id: automation.id,
                          enabled: automation.enabled,
                          aiDisclosure: automation.webchat?.aiDisclosure !== false,
                          turnstile: automation.webchat?.antiBot === "turnstile",
                          googleSignIn: automation.webchat?.access === "google",
                      },
                  ]
                : [],
        ),
        browsers: capabilities.filter((capability) => capability.kind === "browser").length,
        speechCloud: settings.voice.cloud?.provider,
        platform: { url: config.platform.url, state: services.announcer.status().state },
        ingress: {
            by: reachPosture({ url: config.ingress.url, grant: config.sandbox.grant, frontDoor: profileTraits(config).extraListeners }).by,
            ingressUrl: config.ingress.url,
            publicUrl: config.sandbox.publicUrl,
        },
        updateChecks: profileTraits(config).containerUpdates && !isDevBuild,
        pushChannels: channels.length,
        members: {
            total: members.length,
            guests: members.filter((member) => member.role === "guest").length,
            fenced: members.filter((member) => member.areas !== undefined).length,
            emailSignIn: members.filter((member) => member.emailSignIn === true).length,
        },
        areas: areas.length,
        agentDomain: domain.agentDomain,
        credentialGates: gates.length,
        hostGuards: guards.filter((guard) => guard.guard).length,
        atRestKey: atRestKeyReadable(),
        version: services.info?.version ?? "",
    };
};
