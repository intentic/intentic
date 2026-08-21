import type { Capability, EndpointConfig, LocalModelConfig } from "@intentic/sandbox-contract";

/* A LOCAL MODEL, EXPRESSED AS THE ENDPOINT IT IS, the pure half of the `localmodel` kind, beside the endpoint
 * config readers because it answers the same three consumers: the catalog probe, the translator reconciler and
 * the turn's credential resolution all take an EndpointConfig, and a localmodel entry becomes one HERE, in
 * exactly one place, so the port the handler serves on and the port the turn dials can never be two opinions.
 *
 * The daemon owns the URL: nothing about it is typed on the card, so it is derived from the entry's id rather
 * than stored, and re-derives identically wherever it is asked for. A config field would be one more thing a
 * hand-edited manifest could set to a port nothing is listening on. */

/* One loopback port per entry, derived from the id (FNV-1a over a 400-port band). Deterministic because three
 * independent readers need the same answer without a registry: the handler that starts llama-server, the
 * translator entry that routes turns at it, and the boot restore that respawns it. A band collision between two
 * entries is possible and cheap to see (the second server exits "address in use", in its visible panel
 * terminal), which is the right trade against inventing port state that a rename or restore could lose. */
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

// Loopback and openai-protocol by construction: llama-server binds 127.0.0.1 in this container and speaks
// OpenAI /v1, so unlike a user-added endpoint there is nothing here a card could get wrong.
export const localModelEndpointConfig = (id: string): EndpointConfig => ({
    baseUrl: `http://127.0.0.1:${localModelPort(id)}/v1`,
    protocol: "openai",
});

/* THE ONE READER OF "WHICH CAPABILITIES ARE ENDPOINTS", for every consumer that treats the two kinds as one
 * provider family (which is all of them): a user-added endpoint carries its config verbatim, a local model
 * derives it, and anything else is not an endpoint. Kept total over the union so a third endpoint-minting kind
 * has to answer here before it can exist half-wired. */
export const endpointConfigOf = (capability: Capability): EndpointConfig | undefined =>
    capability.kind === "endpoint" ? capability.config : capability.kind === "localmodel" ? localModelEndpointConfig(capability.id) : undefined;

// Whether this kind mints an `endpoint/<id>` provider, the predicate behind every "keep the translator in
// step" hook on the capability routes. Derived from the resolver above rather than a second kind list.
export const mintsEndpointProvider = (kind: Capability["kind"]): boolean => kind === "endpoint" || kind === "localmodel";

/* WHICH WEIGHTS, resolved from the card's two fields. The curated select stores a Hugging Face path
 * (`owner/repo/…/file.gguf`); the reserved "custom" value defers to the url field. `file` is the name the
 * weights are cached under (the path's last segment), shared across entries on purpose: two cards naming the
 * same model download it once.
 *
 * Undefined is a refusal the handler words, not a fallback: "custom" with no URL and a path with fewer than
 * three segments are both a card that cannot say which bytes to fetch, and inventing a default model here would
 * download gigabytes the user never chose. */
export interface LocalModelSource {
    // Hugging Face repo + path-in-repo, for @huggingface/hub's downloadFile (whose Xet bridge is why this is
    // not a URL: anonymous plain-HTTP fetches of HF weights 403, see speech/transcribe.ts).
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

// What the picker's rows and the card's status call the model: the file, shorn of its extension and quant
// suffix noise only a download needs ("Qwen3-4B-Instruct-2507-Q4_K_M.gguf" → "Qwen3-4B-Instruct-2507-Q4_K_M").
export const localModelLabel = (config: LocalModelConfig): string =>
    (localModelSource(config)?.file ?? config.model).replace(/\.gguf$/i, "");
