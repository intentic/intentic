import type { AgentProvider } from "../schemas/agent.js";
import type { EndpointProtocol } from "../schemas/capabilities.js";

// The model APIs this sandbox knows how to reach with nothing but a key, read by the daemon (an API key found on the
// owner's computer, migrations/provider-keys.ts) and by the editor (one pasted by hand beside a provider's sign-in). A key
// becomes a model `endpoint`; each base is the vendor's own documented one, and each serves `GET <base>/models` in the
// shape the endpoint catalog reads, which is what makes a key a provider in the picker.
export interface KeyProvider {
    readonly id: string;
    readonly label: string;
    // Other names the source tools file the same provider under (opencode's models.dev ids, OpenClaw's profiles).
    readonly aliases: readonly string[];
    // The environment names a `.env` holds its key under.
    readonly env: readonly string[];
    readonly baseUrl: string;
    readonly protocol: EndpointProtocol;
    // The sign-in whose card offers this key as the deliberate alternative, where the vendor sells both: the same models,
    // paid per token instead of through a plan.
    readonly beside?: AgentProvider;
    // Where the vendor hands out keys, and where it says what they cost: both said before a key is asked for.
    readonly keysUrl?: string;
    readonly pricingUrl?: string;
}

export const KEY_PROVIDERS: readonly KeyProvider[] = [
    {
        id: "anthropic",
        label: "Anthropic",
        aliases: [],
        env: ["ANTHROPIC_API_KEY"],
        baseUrl: "https://api.anthropic.com",
        protocol: "anthropic",
        beside: "claude",
        keysUrl: "https://console.anthropic.com/settings/keys",
        pricingUrl: "https://www.anthropic.com/pricing#api",
    },
    {
        id: "openai",
        label: "OpenAI",
        aliases: [],
        env: ["OPENAI_API_KEY"],
        baseUrl: "https://api.openai.com/v1",
        protocol: "openai",
        beside: "codex",
        keysUrl: "https://platform.openai.com/api-keys",
        pricingUrl: "https://openai.com/api/pricing/",
    },
    { id: "openrouter", label: "OpenRouter", aliases: [], env: ["OPENROUTER_API_KEY"], baseUrl: "https://openrouter.ai/api/v1", protocol: "openai" },
    {
        id: "gemini",
        label: "Gemini",
        aliases: ["google", "google-gemini"],
        env: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
        // The platform's free trial reads the same surface (_platform/api config.ts `trial.baseUrl`).
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
        protocol: "openai",
        beside: "gemini",
        keysUrl: "https://aistudio.google.com/apikey",
        pricingUrl: "https://ai.google.dev/gemini-api/docs/pricing",
    },
    {
        id: "xai",
        label: "xAI",
        aliases: ["grok", "x-ai"],
        env: ["XAI_API_KEY", "GROK_API_KEY"],
        baseUrl: "https://api.x.ai/v1",
        protocol: "openai",
        beside: "grok",
        keysUrl: "https://console.x.ai",
        pricingUrl: "https://docs.x.ai/docs/models",
    },
    { id: "deepseek", label: "DeepSeek", aliases: [], env: ["DEEPSEEK_API_KEY"], baseUrl: "https://api.deepseek.com/v1", protocol: "openai" },
    { id: "groq", label: "Groq", aliases: [], env: ["GROQ_API_KEY"], baseUrl: "https://api.groq.com/openai/v1", protocol: "openai" },
    { id: "mistral", label: "Mistral", aliases: [], env: ["MISTRAL_API_KEY"], baseUrl: "https://api.mistral.ai/v1", protocol: "openai" },
    {
        id: "moonshot",
        label: "Moonshot",
        aliases: ["moonshotai"],
        env: ["MOONSHOT_API_KEY"],
        baseUrl: "https://api.moonshot.ai/v1",
        protocol: "openai",
        beside: "kimi",
        keysUrl: "https://platform.moonshot.ai/console/api-keys",
        pricingUrl: "https://platform.moonshot.ai/docs/pricing/chat",
    },
];

// The key a provider's card offers as its alternative to signing in, if its vendor sells one.
export const keyBeside = (provider: AgentProvider): KeyProvider | undefined => KEY_PROVIDERS.find((entry) => entry.beside === provider);

// Its address without the slash a hand-typed one may end in, so the same API reads as the same API.
const sameBase = (one: string, other: string): boolean => one.trim().replace(/\/+$/, ``).toLowerCase() === other.trim().replace(/\/+$/, ``).toLowerCase();

// The vendor an endpoint is the API of, read off its address: what a key becomes is an endpoint at exactly that base,
// whether pasted beside a sign-in or copied from the owner's computer. Any other address (a gateway, a server of the
// owner's) is no vendor's here, even one that serves the same models.
export const keyProviderFor = (baseUrl: string): KeyProvider | undefined => KEY_PROVIDERS.find((entry) => sameBase(entry.baseUrl, baseUrl));
