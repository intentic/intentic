// Builds the web editor's demo for production (as the phone lab does, `_tools/perf/src/mobile/build.ts`) and serves it
// (`serve.ts`) with one script ahead of the app's own: the phone lab's transcript inflation and streamed turn
// (`page-scripts.ts`, `chat/stream.ts`) plus this bench's driver (`inject.ts`), each serialised from its source so the
// web arm draws the same conversation and streams the same turn the native arms do. The page reads its asks from the
// address WebConversationActivity opens (`spikeRows`, `spikeStream`, `spikeStreamMs`, `spikeDelayMs`).

import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { buildDemo } from "../../../_tools/perf/src/mobile/build.ts";
import { inflateTranscript } from "../../../_tools/perf/src/mobile/page-scripts.ts";
import { serveBuild, type StaticServer } from "../../../_tools/perf/src/mobile/serve.ts";
import { streamTurn } from "../../../_tools/perf/src/chat/stream.ts";
import { spikeDriver } from "./inject.ts";

const CONVERSATION = `cnv_soft_deletes`;
const PROMPT = `Run the migration against a copy of the schema, then its tests.`;

/** The script every page gets first. `copies` is how many fixture copies make `spikeRows` rows (the last is whole). */
const injection = (fixtureRows: number): string => `(() => {
    const ask = new URLSearchParams(location.search);
    const rows = Number(ask.get("spikeRows") ?? "2000");
    const stream = ask.get("spikeStream") === "1";
    (${inflateTranscript.toString()})({ conversationId: ${JSON.stringify(CONVERSATION)}, copies: Math.ceil(rows / ${fixtureRows}) });
    if (stream) {
        (${streamTurn.toString()})({ conversationId: ${JSON.stringify(CONVERSATION)}, ms: Number(ask.get("spikeStreamMs") ?? "10000") });
    }
    (${spikeDriver.toString()})({ stream, streamDelayMs: Number(ask.get("spikeDelayMs") ?? "1500"), prompt: ${JSON.stringify(PROMPT)} });
})();
`;

export const serveWeb = async (repo: string, out: string, rebuild: boolean): Promise<StaticServer> => {
    const dist = join(out, `demo`);
    if (rebuild || !existsSync(join(dist, `index.html`))) {
        process.stdout.write(`building the web demo into ${dist}\n`);
        await buildDemo(repo, dist);
    }
    // SAFETY: fixture/soft-deletes.json is only ever written by fixture/make-fixture.ts, whose output has a rows array.
    const fixture = JSON.parse(readFileSync(new URL(`../fixture/soft-deletes.json`, import.meta.url), `utf8`)) as { readonly rows: readonly unknown[] };
    const script = injection(fixture.rows.length);
    const index = readFileSync(join(dist, `index.html`), `utf8`).replace(`<head>`, `<head><script src="/spike/inject.js"></script>`);
    // The page's address is a route of the app, never a file: answered with the index carrying the injected script.
    const claim = (request: IncomingMessage, response: ServerResponse): boolean => {
        const path = new URL(request.url ?? `/`, `http://x`).pathname;
        if (path === `/spike/inject.js`) {
            response.writeHead(200, { "content-type": `text/javascript`, "cache-control": `no-store` });
            response.end(script);
            return true;
        }
        if (path.startsWith(`/demo/`) && !/\.[a-z0-9]+$/iu.test(path)) {
            response.writeHead(200, { "content-type": `text/html`, "cache-control": `no-cache` });
            response.end(index);
            return true;
        }
        return false;
    };
    return serveBuild(dist, `/demo/`, claim);
};
