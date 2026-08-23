import { type Capability, type EndpointConfig, LOCAL_MODEL_WINDOW_DEFAULT, type LocalModelConfig } from "@intentic/sandbox-contract";

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
// suffix noise only a download needs ("Qwen3.5-9B-Q4_K_M.gguf" → "Qwen3.5-9B-Q4_K_M").
export const localModelLabel = (config: LocalModelConfig): string => (localModelSource(config)?.file ?? config.model).replace(/\.gguf$/i, "");

/* HOW MANY TOKENS THIS ENTRY'S SERVER HOLDS, from the card's two fields, and the only place that decides it.
 *
 * Three readers need the same answer and none of them may hold their own copy: the handler starts llama-server
 * with it (`--ctx-size`), the card's status quotes it back to the person who chose it, and the apply's one line
 * names it while the download begins. A second opinion here would be a card promising a window the server is
 * not serving, which is precisely the class of bug the flat cap this replaced was covering up.
 *
 * "custom" with nothing typed falls back to the default rather than refusing, unlike the missing GGUF url next
 * to it, and the asymmetry is the point: a card that cannot name which bytes to fetch can do nothing at all,
 * while a card that did not finish naming a window has a perfectly good answer available. The number it lands
 * on is said out loud by the apply and the status, so the fallback is visible rather than assumed. */
export const localModelWindow = (config: LocalModelConfig): number =>
    config.context === "custom" ? (config.contextTokens ?? Number(LOCAL_MODEL_WINDOW_DEFAULT)) : Number(config.context);

// How the window reads on a card and in a log line: "64k", never "65536". The rungs are all whole thousands of
// tokens; a typed number that isn't (3,000) keeps its digits rather than rounding to a lie.
export const localModelWindowLabel = (tokens: number): string => (tokens % 1024 === 0 ? `${tokens / 1024}k` : String(tokens));

// Whether a window this size can hold a turn of the full agent loop, which is what decides if the card says
// "quick jobs only" beside it. The threshold is the contract's default rung, for the reason stated there: it is
// the smallest one a real turn fits in, so anything under it is a deliberate trade the card must not hide.
export const fitsAgentTurn = (tokens: number): boolean => tokens >= Number(LOCAL_MODEL_WINDOW_DEFAULT);
