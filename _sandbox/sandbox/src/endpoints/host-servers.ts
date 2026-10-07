import type { Capability, HostModelServer } from "@intentic/sandbox-contract";
import { z } from "zod";
import { versionedBase } from "./endpoint-config.js";

// The model servers already running on the computer that hosts this sandbox. A GPU model is served there (Ollama, LM
// Studio, llama.cpp, vLLM talk to the driver directly, with nothing compiled into this image) and reached as a model
// endpoint; this finds them by asking each one's usual port, so pointing at one is a press rather than a form.

// Docker's name for the hosting computer, from inside the container (the runner adds it as host-gateway).
const HOST = "host.docker.internal";

// Each program's default port, in the order the panel lists them. A port answering for another program reads as that
// program, which is fine: what matters is that it serves models, and the list it answers with is the proof.
const KNOWN: readonly { readonly port: number; readonly kind: HostModelServer["kind"]; readonly label: string }[] = [
    { port: 11_434, kind: "ollama", label: "Ollama" },
    { port: 1234, kind: "lmstudio", label: "LM Studio" },
    { port: 8080, kind: "llamacpp", label: "llama.cpp" },
    { port: 8000, kind: "vllm", label: "vLLM" },
];

// Short: a server on this machine answers in milliseconds, and a port with nothing behind it must not hold up the panel.
const PROBE_TIMEOUT_MS = 1_500;

const ModelListSchema = z.object({ data: z.array(z.object({ id: z.string().min(1) })) });

const sameServer = (left: string, right: string): boolean => versionedBase(left).toLowerCase() === versionedBase(right).toLowerCase();

const probe = async (baseUrl: string, fetchImpl: typeof fetch): Promise<readonly string[] | undefined> => {
    const response = await fetchImpl(`${baseUrl}/models`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }).catch(() => undefined);
    if (response === undefined || !response.ok) {
        return undefined;
    }
    const parsed = ModelListSchema.safeParse(await response.json().catch(() => undefined));
    return parsed.success ? parsed.data.data.map((model) => model.id) : undefined;
};

// Every known port that answers with a model list, each with the endpoint already pointing at it. A server listing no
// models still counts: Ollama with nothing pulled yet is running, and the row says so.
export const findHostServers = async (capabilities: readonly Capability[], fetchImpl: typeof fetch = fetch): Promise<HostModelServer[]> => {
    const found = await Promise.all(
        KNOWN.map(async ({ port, kind, label }): Promise<HostModelServer | undefined> => {
            const baseUrl = `http://${HOST}:${port}/v1`;
            const models = await probe(baseUrl, fetchImpl);
            if (models === undefined) {
                return undefined;
            }
            const existing = capabilities.find((capability) => capability.kind === "endpoint" && sameServer(capability.config.baseUrl, baseUrl));
            return { kind, label, baseUrl, models: [...models], ...(existing === undefined ? {} : { capability: existing.id }) };
        }),
    );
    return found.filter((server) => server !== undefined);
};
