#!/usr/bin/env node
// Records what this sandbox's own daemon sends, into fixtures/live/, for `cargo test`'s live check (tests/wire/live.rs)
// to decode with src/wire/'s types. The recordings hold the owner's own conversations, so fixtures/live/ is ignored by
// git and must stay that way.
//
// Run as root inside the sandbox, which is what lets it mint a host session (the daemon's
// auth/host/host-session-cli.js, as `ic sandbox session` does through `docker exec`): a session for the bound owner
// that the daemon accepts only on netd's loopback port. The token never leaves this process. Read-only: it opens
// `/events` without a client id (so it joins no presence roster), lists the fleet, and pages and attaches to a few
// conversations without sending anything.
//
//   node _editor/mobile-core/fixtures/record-live.mjs [daemon base, default http://127.0.0.1:8788] [conversations, default 6]
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const base = process.argv[2] ?? "http://127.0.0.1:8788";
const conversations = Number(process.argv[3] ?? 6);
const out = new URL("live/", import.meta.url);
mkdirSync(out, { recursive: true });

const minted = JSON.parse(execFileSync("node", ["/opt/sandbox/dist/auth/host/host-session-cli.js"], { encoding: "utf8" }));
const headers = { authorization: `Bearer ${minted.token}`, "content-type": "application/json" };

// A request's options; only a POST carries a body.
const request = (method, body, extra = {}) => {
    const options = { method, headers: { ...headers, ...extra.headers }, signal: extra.signal };
    if (method === "POST") {
        options.body = JSON.stringify(body ?? {});
    }
    return options;
};

const json = async (method, path, body) => {
    const response = await fetch(`${base}${path}`, request(method, body));
    if (!response.ok) {
        throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    }
    return response.json();
};

// The parsed `data` of one SSE block when it is an oRPC `message` event; keep-alives and other events give nothing.
const messageOf = (block) => {
    const lines = block.split("\n");
    const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() ?? "message";
    const data = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
    return event === "message" && data !== "" ? [JSON.parse(data)] : [];
};

// The `data` of each `message` event of an oRPC event iterator, until the stream ends, `stop` says so, or `ms` pass.
const frames = async (method, path, body, ms, stop) => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), ms);
    const seen = [];
    try {
        const response = await fetch(`${base}${path}`, request(method, body, { headers: { accept: "text/event-stream" }, signal: abort.signal }));
        if (!response.ok) {
            throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
        }
        const decoder = new TextDecoder();
        let buffer = "";
        for await (const chunk of response.body) {
            const blocks = (buffer + decoder.decode(chunk, { stream: true })).split("\n\n");
            buffer = blocks.pop();
            seen.push(...blocks.flatMap(messageOf));
            if (seen.some(stop)) {
                abort.abort();
                return seen;
            }
        }
    } catch (error) {
        if (error.name !== "AbortError") {
            throw error;
        }
    } finally {
        clearTimeout(timer);
    }
    return seen;
};

const write = (name, value) => writeFileSync(new URL(name, out), `${JSON.stringify(value, null, 1)}\n`);

write("events.json", await frames("GET", "/events", undefined, 12_000, () => false));
const fleet = await json("GET", "/agents");
write("agents.json", fleet);
const picked = fleet.agents.toSorted((a, b) => b.updatedAt - a.updatedAt).slice(0, conversations);
const transcripts = {};
const attaches = {};
for (const agent of picked) {
    transcripts[agent.id] = await json("GET", `/agents/${encodeURIComponent(agent.id)}/transcript?turns=4`);
    attaches[agent.id] = await frames("POST", "/agent/attach", { conversationId: agent.id }, 6_000, (frame) => frame.kind === "end");
}
write("transcripts.json", transcripts);
write("attach.json", attaches);
console.log(`recorded ${picked.length} conversations from ${base} into ${out.pathname}`);
