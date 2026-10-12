import type { ExtensionProcessApi } from "@intentic/extension-api/runtime";
import type { ListenerDispatchFrame, ListenerMessage, ListenerStatus } from "@intentic/sandbox-contract";
import { type ListenerState, listenerRouteUrl, ListenerStateSchema } from "@intentic/sandbox-contract/listener-protocol";
import { parsedJsonLines } from "@intentic/base/json-lines";
import { chunksOf } from "@intentic/base/web-stream";
import type { Logger } from "./log.js";

// The gateway's client for the daemon's provider-scoped listener routes (app.ts / listener.routes.ts): the daemon holds
// no provider connection itself, so every automation interaction rides these four routes, through the process's own
// `api.daemon` (@intentic/extension-api/runtime), which presents the extension's token: the daemon answers them only for
// the extension whose manifest declares this provider as its listener. Paths, shapes and the state feed's schema come
// from the contract's listener-protocol, the same declaration the daemon serves from (the subpath, so a gateway loads no
// more of the contract than that).

// The one door the client needs: a request to a daemon path with the extension's token already on it.
export type DaemonDoor = Pick<ExtensionProcessApi["daemon"], "request">;

// The reconcile feed /listeners/<provider>/state serves (the contract's ListenerState): enabled automations for this
// provider, plus the connector capabilities this extension contributes, with full config (secrets included, the gateway
// needs them). `TConfig` is the connector's own config shape, which the feed's schema leaves to the connector.
export type DaemonState<TConfig> = Omit<ListenerState, "connectors"> & {
    readonly connectors: ReadonlyArray<{ id: string; config: TConfig }>;
};

// One utterance from the sandbox's own voice: mono s16le at `sampleRate`, one rate for the whole answer, streamed as the
// daemon makes it.
export interface Speech {
    readonly sampleRate: number;
    readonly pcm: AsyncIterable<Uint8Array>;
}

export interface SpeakOptions {
    // The listeners' language, a hint the text's own language overrides when it can be told.
    readonly lang?: string | undefined;
    // Aborting stops the daemon mid-sentence: the request is dropped and it stops making speech nobody will hear.
    readonly signal?: AbortSignal | undefined;
}

export interface DaemonClient<TConfig> {
    readonly state: () => Promise<DaemonState<TConfig>>;
    readonly dispatch: (message: ListenerMessage) => Promise<void>;
    readonly dispatchStreaming: (message: ListenerMessage, onFrame: (frame: ListenerDispatchFrame) => void) => Promise<void>;
    // Reports never reject: a connector fires them and moves on, so a report the daemon did not take is logged here.
    readonly failure: (detail: string) => Promise<void>;
    readonly status: (snapshot: ListenerStatus) => Promise<void>;
    // One utterance (a 16 kHz mono s16le WAV) to its words through the sandbox's own speech engine, empty when it held
    // none. Waits out the model's first fetch rather than refusing; the manifest must declare POST /speech/transcribe.
    readonly transcribe: (wav: Uint8Array, language: string | undefined) => Promise<string>;
    // Text to speech through the sandbox's own voice, the one the owner set for the text's language; undefined when the
    // text held nothing to say. The manifest must declare POST /speech/say.
    readonly speak: (text: string, options?: SpeakOptions) => Promise<Speech | undefined>;
}

// A speech route's refusal as one sentence: the status and the start of what the daemon said about it.
const refusal = async (route: string, res: Response, log: Logger): Promise<Error> => {
    const detail = await res.text().catch((error: Error) => {
        log.warn({ err: error }, `${route} returned ${res.status} and its body could not be read`);
        return "";
    });
    return new Error(`${route} returned ${res.status}${detail === "" ? "" : `: ${detail.slice(0, 200)}`}`);
};

export const createDaemonClient = <TConfig>(provider: string, daemon: DaemonDoor, log: Logger): DaemonClient<TConfig> => {
    const url = (route: Parameters<typeof listenerRouteUrl>[0]): string => listenerRouteUrl(route, provider);
    const jsonHeaders = { "content-type": "application/json" };
    const report = async (path: "failure" | "status", body: unknown, context: object): Promise<void> => {
        try {
            const res = await daemon.request(url(path), { method: "POST", headers: jsonHeaders, body: JSON.stringify(body) });
            await res.text();
            if (!res.ok) {
                log.warn({ ...context, status: res.status }, `${listenerRouteUrl(path, provider)} returned ${res.status}`);
            }
        } catch (error) {
            log.warn({ ...context, err: error }, `${listenerRouteUrl(path, provider)} failed`);
        }
    };
    return {
        state: async () => {
            const res = await daemon.request(url("state"));
            if (!res.ok) {
                throw new Error(`${listenerRouteUrl("state", provider)} returned ${res.status}`);
            }
            // The schema checks the feed's frame; a connector's config is its own shape, read by the connector.
            return ListenerStateSchema.parse(await res.json()) as DaemonState<TConfig>;
        },
        dispatch: async (message) => {
            const res = await daemon.request(url("dispatch"), { method: "POST", headers: jsonHeaders, body: JSON.stringify(message) });
            await res.text();
            if (!res.ok) {
                throw new Error(`${listenerRouteUrl("dispatch", provider)} returned ${res.status}`);
            }
        },
        dispatchStreaming: async (message, onFrame) => {
            const res = await daemon.request(`${url("dispatch")}?stream=1`, { method: "POST", headers: jsonHeaders, body: JSON.stringify(message) });
            if (!res.ok || res.body === null) {
                await res.text().catch(() => undefined);
                throw new Error(`${listenerRouteUrl("dispatch", provider)}?stream returned ${res.status}`);
            }
            // A line that is not JSON costs that line, logged, and never the frames after it: the reply is still
            // streaming into the owner's channel.
            const skipped = (line: string): void => log.warn({ line: line.slice(0, 200) }, `${listenerRouteUrl("dispatch", provider)}?stream sent a line that is not JSON`);
            for await (const frame of parsedJsonLines(chunksOf(res.body), skipped)) {
                // SAFETY: only the daemon writes these frames (the contract keeps them a type, not a schema), and a line
                // that did not parse never reaches here.
                onFrame(frame as ListenerDispatchFrame);
            }
        },
        failure: (detail) => report("failure", { detail }, { detail }),
        transcribe: async (wav, language) => {
            const query = new URLSearchParams({ wait: "1", ...(language === undefined ? {} : { lang: language }) });
            const res = await daemon.request(`/speech/transcribe?${query}`, {
                method: "POST",
                headers: { "content-type": "audio/wav" },
                body: new Blob([new Uint8Array(wav)], { type: "audio/wav" }),
            });
            if (!res.ok) {
                throw await refusal("/speech/transcribe", res, log);
            }
            const { text } = (await res.json()) as { text?: unknown };
            return typeof text === "string" ? text : "";
        },
        speak: async (text, options = {}) => {
            const query = new URLSearchParams({ as: "plain" });
            if (options.lang !== undefined) {
                query.set("lang", options.lang);
            }
            const res = await daemon.request(`/speech/say?${query}`, {
                method: "POST",
                headers: { "content-type": "text/plain; charset=utf-8" },
                body: text,
                signal: options.signal ?? null,
            });
            // 204 is the daemon finding nothing to say in the text (only markup, say), which is no failure.
            if (res.status === 204) {
                return undefined;
            }
            if (!res.ok || res.body === null) {
                throw await refusal("/speech/say", res, log);
            }
            const sampleRate = Number(res.headers.get("x-sample-rate"));
            if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
                await res.body.cancel();
                throw new Error(`/speech/say answered without a sample rate (x-sample-rate: ${res.headers.get("x-sample-rate") ?? "absent"})`);
            }
            return { sampleRate, pcm: chunksOf(res.body) };
        },
        status: (snapshot) => report("status", snapshot, {}),
    };
};
