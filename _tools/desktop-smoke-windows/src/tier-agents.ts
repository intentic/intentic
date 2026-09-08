// Tier 3: from this machine, is the sandbox reachable at the browser's derived loopback address, is its gate real, and
// does one /agents turn complete. The control token is seeded, not minted (minting needs a person's Google login); a
// missing shared agent-auth volume stands the turn down instead of failing it.

import { randomUUID } from "node:crypto";
import { LOCAL_PORT, STATE_DIR, WORKSPACE_ROOT } from "@intentic/constants";
import { localDaemonPort } from "@intentic/sandbox-run";
import { shellQuote } from "@intentic/sandbox-run/quote";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { CONNECT_TOKEN } from "./constants.js";
import type { Harness } from "./harness.js";
import { assistantReplied, controlTokenSeedScript, controlTokenStore, sameStore } from "./parse.js";
import { containersPublishing, publishedHostPort } from "./probe.js";
import { run } from "./run.js";

export interface AgentsTierOptions {
    /** Container tier 2 brought up. */
    readonly container: string;
    /** Docker volume with an already-connected AI account; absent, the turn stands down naming it. */
    readonly agentAuthVolume: string | undefined;
    /** How long one turn may take before this gives up on it. */
    readonly turnSeconds: number;
}

// Smallest prompt only a running model can answer; a short-circuit or a longer prompt proves nothing extra.
const PROMPT = `Reply with exactly the word: ready`;
const EXPECTED = `ready`;

const STORE_PATH = `${WORKSPACE_ROOT}/${STATE_DIR}/identity/control-tokens.json`;

// sha256 computed inside the container, matching its own code. Reports which step failed (hashing vs writing) rather
// than a bare false, since the two fail for different reasons.
const seedControlToken = async (container: string, token: string): Promise<string | undefined> => {
    const digest = await run(`docker`, [`exec`, container, `sh`, `-c`, `printf %s ${shellQuote(token)} | sha256sum | cut -d" " -f1`]);
    if (digest.code !== 0) {
        return `hashing the token in the container exited ${digest.code}: ${digest.stderr.trim()}`;
    }
    const store = controlTokenStore(digest.stdout.trim());
    const write = await run(`docker`, [`exec`, container, `sh`, `-c`, controlTokenSeedScript(STORE_PATH, store)]);
    if (write.code !== 0) {
        return `writing ${STORE_PATH} exited ${write.code}: ${write.stderr.trim()}`;
    }
    // Reads it back: a shell can write an empty file on a heredoc it never saw the end of and still exit 0.
    const back = await run(`docker`, [`exec`, container, `cat`, STORE_PATH]);
    if (back.code !== 0) {
        return `reading ${STORE_PATH} back exited ${back.code}: ${back.stderr.trim()}`;
    }
    return sameStore(store, back.stdout) ? undefined : `${STORE_PATH} does not hold what was written to it:\n${back.stdout.trim()}`;
};

interface DaemonCall {
    readonly status: number;
    readonly body: string;
}

// Called from the Windows host over the derived loopback address, not from inside the container: that's the half tier 2
// doesn't cover.
const callDaemon = async (port: number, path: string, token: string | undefined, body?: unknown): Promise<DaemonCall> => {
    const headers: Record<string, string> = { "content-type": `application/json` };
    if (token !== undefined) {
        headers[`x-intentic-control`] = token;
    }
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: body === undefined ? `GET` : `POST`,
        headers,
        // Spread, not an explicit undefined: a GET with a body key present is a different request to fetch.
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(60_000),
    });
    return { status: response.status, body: await response.text() };
};

// Confirms which sandbox answers before asking anything of it: another correctly-gated one would pass every check up to
// the credential. A derived port can be squatted by an older leftover, since ic retries without it rather than failing.
const publishesTheShortcut = async (harness: Harness, container: string, port: number): Promise<boolean> => {
    const published = await publishedHostPort(container, LOCAL_PORT);
    if (published === port) {
        harness.pass(`${container} publishes its loopback listener on ${port}`);
        return true;
    }
    const holders = (await containersPublishing(port)).filter((name) => name !== container);
    harness.fail(
        published === undefined
            ? `${container} publishes no host port for its loopback listener`
            : `${container} publishes its loopback listener on ${published}, not the derived ${port}`,
        `A browser on this machine derives ${port} from the sandbox id and would reach ${holders.length === 0 ? `nothing` : holders.join(`, `)}.\n` +
            `The publish is dropped rather than failed when that port is already held, so the setup completed regardless.`,
    );
    return false;
};

// Asserted before the credential is used: an ungated daemon that answers everything looks identical otherwise, and a
// mis-gated one refuses to boot at all.
const gateIsReal = async (harness: Harness, port: number): Promise<void> => {
    const unauthenticated = await callDaemon(port, `/agents`, undefined);
    if (unauthenticated.status === 401 || unauthenticated.status === 403) {
        harness.pass(`an uncredentialed call is refused (${unauthenticated.status})`);
        return;
    }
    harness.fail(`an uncredentialed /agents answered ${unauthenticated.status}`, `This daemon is reachable and ungated.`);
};

export const runAgentsTier = async (harness: Harness, options: AgentsTierOptions): Promise<void> => {
    const sandboxId = sandboxIdFromToken(CONNECT_TOKEN);
    if (sandboxId === undefined) {
        harness.fail(`no sandbox id derives from the connect token`, `The token this tier's setup used is not one a sandbox id can be read from.`);
        return;
    }
    const port = localDaemonPort(sandboxId);

    // reachable from the host, at the address the browser derives
    harness.section(`the loopback shortcut (port ${port}, derived from sandbox ${sandboxId})`);

    if (!(await publishesTheShortcut(harness, options.container, port))) {
        return;
    }

    const reachable = await harness.untilTrue(60, `the daemon answers /health on the host's loopback`, async () => {
        const health = await callDaemon(port, `/health`, undefined);
        return health.status === 200;
    });
    if (!reachable) {
        harness.detail(
            `The container publishes its loopback listener on this port so a browser on this machine can skip the tunnel.\n` +
                `Nothing answering means the publish did not happen: every local workspace would fall back to the tunnel.`,
        );
        return;
    }

    // the gate is real
    await gateIsReal(harness, port);

    // the credential a program is meant to use
    harness.section(`driving it with a control token`);
    const token = `ict_windows_smoke_${sandboxId}`;
    const unseeded = await seedControlToken(options.container, token);
    if (unseeded !== undefined) {
        harness.fail(`could not seed a drive-scoped control token into ${options.container}`, unseeded);
        return;
    }
    harness.pass(`a drive-scoped control token is in place`);

    const fleet = await callDaemon(port, `/agents`, token);
    if (fleet.status === 200) {
        harness.pass(`/agents answers the control token`);
    } else {
        harness.fail(`/agents answered ${fleet.status} to a drive-scoped token`, fleet.body.slice(0, 500));
        return;
    }

    // one turn
    if (options.agentAuthVolume === undefined) {
        harness.section(`one /agents turn: stood down, no INTENTIC_AGENT_AUTH_VOLUME`);
        harness.pass(`everything up to the turn passed. Connect an AI account once on this machine and name its volume to run the turn too.`);
        return;
    }

    harness.section(`one /agents turn`);
    // Client-minted once; the same stable id ties turn, registry card, poll and transcript together.
    const conversationId = `windows-smoke-${randomUUID()}`;
    const started = await callDaemon(port, `/agent`, token, { conversationId, prompt: PROMPT, title: `windows smoke` });
    if (started.status !== 200) {
        harness.fail(`starting a turn answered ${started.status}`, started.body.slice(0, 800));
        return;
    }
    harness.pass(`the turn started`);

    // Polls the transcript, not the roster (summaries can't prove which reply is this turn's); requires an assistant
    // bubble so the prompt's own word can't satisfy it early.
    let transcript = await callDaemon(port, `/agents/${encodeURIComponent(conversationId)}/transcript`, token);
    const done = await harness.untilTrue(options.turnSeconds, `the turn completed`, async () => {
        transcript = await callDaemon(port, `/agents/${encodeURIComponent(conversationId)}/transcript`, token);
        return transcript.status === 200 && assistantReplied(transcript.body, EXPECTED);
    });
    if (!done) {
        const state = await callDaemon(port, `/agents/${encodeURIComponent(conversationId)}`, token);
        harness.detail(`agent: ${state.body.slice(0, 800)}\ntranscript: ${transcript.body.slice(0, 800)}`);
        return;
    }
    harness.pass(`the agent replied, and the reply reached its transcript`);
};
