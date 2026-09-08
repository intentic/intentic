import { type Capability, type EndpointConfig, LOCAL_MODEL_WINDOW_DEFAULT, type LocalModelConfig } from "@intentic/sandbox-contract";

// A local model expressed as the endpoint it is: the catalog probe, translator reconciler and credential resolution all
// take an EndpointConfig, and a localmodel entry becomes one only here. The URL is derived from the id rather than
// stored, since nothing about it is typed on the card.

// Port is derived from the id via FNV-1a over a 400-port band, so the handler, translator, and boot restore agree
// without a registry. A collision surfaces as `address in use`, the trade against port state a restore could lose.
const PORT_BASE = 40100;
const PORT_BAND = 400;
export const localModelPort = (id: string): number => {
    let hash = 0x811c9dc5;
    for (let index = 0; index < id.length; index++) {
        hash ^= id.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return PORT_BASE + (hash % PORT_BAND);
};

// Loopback and openai-protocol by construction: llama-server binds 127.0.0.1 here and speaks OpenAI /v1.
export const localModelEndpointConfig = (id: string): EndpointConfig => ({
    baseUrl: `http://127.0.0.1:${localModelPort(id)}/v1`,
    protocol: "openai",
});

// The one reader of which capabilities are endpoints: an endpoint carries its config verbatim, a localmodel derives
// one, anything else is not one. A third endpoint-minting kind must extend this before it can exist half-wired.
export const endpointConfigOf = (capability: Capability): EndpointConfig | undefined =>
    capability.kind === "endpoint" ? capability.config : capability.kind === "localmodel" ? localModelEndpointConfig(capability.id) : undefined;

// Whether a capability kind mints an `endpoint/<id>` provider; derived from endpointConfigOf rather than a separate
// kind list.
export const mintsEndpointProvider = (kind: Capability["kind"]): boolean => kind === "endpoint" || kind === "localmodel";

// Resolved from the card's two fields: a curated pick is a Hugging Face path, `custom` defers to `url`, and `file` is
// the shared cache key. Undefined is a refusal, not a fallback; no default model is substituted.
export interface LocalModelSource {
    // Repo + path-in-repo for @huggingface/hub's downloadFile; not a URL, its Xet bridge needs this shape.
    readonly repo?: string;
    readonly path?: string;
    // A direct GGUF link (the "custom" escape hatch), fetched plainly.
    readonly url?: string;
    readonly file: string;
}

export const localModelSource = (config: LocalModelConfig): LocalModelSource | undefined => {
    if (config.model === "custom") {
        const url = config.url?.trim() ?? "";
        const file = url.split("/").at(-1)?.split("?")[0] ?? "";
        return url === "" || file === "" ? undefined : { url, file };
    }
    const segments = config.model.split("/").filter((segment) => segment !== "");
    if (segments.length < 3) {
        return undefined;
    }
    const repo = segments.slice(0, 2).join("/");
    const path = segments.slice(2).join("/");
    return { repo, path, file: segments.at(-1) ?? "" };
};

// Display name for the picker and card: the file name, minus extension.
export const localModelLabel = (config: LocalModelConfig): string => (localModelSource(config)?.file ?? config.model).replace(/\.gguf$/i, "");

// The one place that resolves the token window; the start flag, card status and apply line must all agree. `custom`
// with no number falls back to the default rung rather than refusing, since a window always has an answer.
export const localModelWindow = (config: LocalModelConfig): number =>
    config.context === "custom" ? (config.contextTokens ?? Number(LOCAL_MODEL_WINDOW_DEFAULT)) : Number(config.context);

// Formats as `64k` rather than `65536`; a value that is not a whole multiple of 1024 keeps its raw digits instead of
// rounding.
export const localModelWindowLabel = (tokens: number): string => (tokens % 1024 === 0 ? `${tokens / 1024}k` : String(tokens));

// Whether a window this size can hold a full agent turn; anything under the contract's default rung is marked "quick
// jobs only".
export const fitsAgentTurn = (tokens: number): boolean => tokens >= Number(LOCAL_MODEL_WINDOW_DEFAULT);
