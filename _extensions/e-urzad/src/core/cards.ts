import { envSuffix } from "@intentic/sandbox-contract/capability-env";
import { type EdSettings, edSettings } from "../ed/system-login.js";
import type { EzdSettings } from "../ezd/key-exchange.js";

// Where a connected card's settings come from. The agent's shell carries every cli card's env vars suffixed with the
// card's instance id (EZDRP_API_URL_<ID>, …), so the CLI finds its cards by scanning for them; the backend is handed the
// card's fields directly (the MCP host, or the daemon's connection read for the view). Both end in the same settings.

export type Service = "ezd-rp" | "e-doreczenia";

type Env = Readonly<Record<string, string | undefined>>;
type Config = Readonly<Record<string, string | number | boolean | undefined>>;

const field = (config: Config, key: string): string => {
    const value = config[key];
    return value === undefined ? "" : String(value).trim();
};

const optional = (value: string): string | undefined => (value === "" ? undefined : value);

export const ezdFromConfig = (card: string, config: Config): EzdSettings => {
    const settings = {
        card,
        apiUrl: field(config, "apiUrl"),
        ssoUrl: field(config, "ssoUrl"),
        webHost: field(config, "webHost"),
        subjectId: field(config, "subjectId"),
        keyId: field(config, "keyId"),
        apiKey: field(config, "apiKey"),
        positionId: optional(field(config, "positionId")),
        userId: optional(field(config, "userId")),
    };
    const missing = (["apiUrl", "ssoUrl", "webHost", "subjectId", "keyId", "apiKey"] as const).filter((key) => settings[key] === "");
    if (missing.length > 0) {
        throw new Error(`the EZD RP card "${card}" is missing ${missing.join(", ")}`);
    }
    return settings;
};

export const edFromConfig = (card: string, config: Config): EdSettings =>
    edSettings({
        card,
        environment: field(config, "environment") || "INT",
        ade: field(config, "ade"),
        systemName: field(config, "systemName"),
        certificate: field(config, "certificate"),
        privateKey: field(config, "privateKey"),
        uaUrl: optional(field(config, "uaUrl")),
        seUrl: optional(field(config, "seUrl")),
        tokenUrl: optional(field(config, "tokenUrl")),
        audience: optional(field(config, "audience")),
    });

// Env var name → card field, per service: the manifest's `env` maps, read backwards.
const EZD_ENV = { EZDRP_API_URL: "apiUrl", EZDRP_SSO_URL: "ssoUrl", EZDRP_WEB_HOST: "webHost", EZDRP_PID: "subjectId", EZDRP_AKI: "keyId", EZDRP_API_KEY: "apiKey", EZDRP_SID: "positionId", EZDRP_UID: "userId" } as const;
const ED_ENV = {
    EDORECZENIA_ENVIRONMENT: "environment",
    EDORECZENIA_ADE: "ade",
    EDORECZENIA_SYSTEM_NAME: "systemName",
    EDORECZENIA_CERTIFICATE: "certificate",
    EDORECZENIA_PRIVATE_KEY: "privateKey",
    EDORECZENIA_UA_URL: "uaUrl",
    EDORECZENIA_SE_URL: "seUrl",
    EDORECZENIA_TOKEN_URL: "tokenUrl",
    EDORECZENIA_AUDIENCE: "audience",
} as const;

const configFromEnv = (env: Env, names: Readonly<Record<string, string>>, suffix: string): Config =>
    Object.fromEntries(Object.entries(names).map(([name, key]) => [key, env[`${name}_${suffix}`]]));

const suffixesOf = (env: Env, marker: string): string[] =>
    Object.keys(env)
        .filter((key) => key.startsWith(`${marker}_`))
        .map((key) => key.slice(marker.length + 1))
        .filter((suffix) => suffix !== "")
        .toSorted();

export interface CardChoice {
    readonly service: Service;
    readonly card: string;
}

export const cardsInEnv = (env: Env): CardChoice[] => [
    ...suffixesOf(env, "EZDRP_API_URL").map((suffix) => ({ service: "ezd-rp" as const, card: suffix.toLowerCase() })),
    ...suffixesOf(env, "EDORECZENIA_ADE").map((suffix) => ({ service: "e-doreczenia" as const, card: suffix.toLowerCase() })),
];

// The card a command runs against: the named one, or the only one of its service. Never a guess between two.
export const pickCard = (env: Env, service: Service, wanted: string | undefined): string => {
    const cards = cardsInEnv(env).filter((choice) => choice.service === service);
    const name = service === "ezd-rp" ? "EZD RP" : "e-Doręczenia";
    if (cards.length === 0) {
        throw new Error(`no ${name} card is connected in this sandbox. Connect one under Capabilities (it is inert until an office does).`);
    }
    if (wanted !== undefined) {
        const found = cards.find((choice) => envSuffix(choice.card) === envSuffix(wanted));
        if (found === undefined) {
            throw new Error(`no ${name} card called "${wanted}"; connected: ${cards.map((choice) => choice.card).join(", ")}`);
        }
        return found.card;
    }
    if (cards.length > 1) {
        throw new Error(`several ${name} cards are connected; pass --card with one of: ${cards.map((choice) => choice.card).join(", ")}`);
    }
    return cards[0]?.card ?? "";
};

export const ezdFromEnv = (env: Env, card: string): EzdSettings => ezdFromConfig(card, configFromEnv(env, EZD_ENV, envSuffix(card)));

export const edFromEnv = (env: Env, card: string): EdSettings => edFromConfig(card, configFromEnv(env, ED_ENV, envSuffix(card)));
