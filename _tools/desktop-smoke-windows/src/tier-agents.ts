/* TIER 3, from this Windows machine, is the sandbox REACHABLE, is its gate real, and does one /agents turn
 * complete?
 *
 * The three questions tier 2 deliberately stops short of. Tier 2 asks the daemon whether it is alive from
 * INSIDE its own container, which is the right question for "did setup work" and the wrong one for "can this
 * machine use it", the address a browser dials, the credential it presents and the answer it gets back are
 * all outside that container.
 *
 * HOW A BROWSER FINDS IT. A sandbox on the same machine as the browser does not go through Cloudflare: the
 * container publishes its loopback listener on a host port DERIVED from the sandbox id, and the browser
 * computes that address rather than being told it. So this tier derives it the same way, from the same
 * function, `localDaemonPort` in `@intentic/sandbox-run`, never a copy of the arithmetic. If the publish is
 * broken on Windows, every local user's workspace silently falls back to the tunnel and nobody finds out here.
 *
 * HOW A PROGRAM AUTHENTICATES. Not by pretending to be a browser. The daemon verifies a real Google ID token
 * on every route but /health, which no CI job can mint, so this uses the credential the product provides for
 * exactly this case: a CONTROL TOKEN, the thing "anything outside the browser presents to drive this sandbox",
 * at `drive` scope, which reaches `POST /agent` and the fleet reads and stops short of landing anything.
 *
 * The token is SEEDED rather than minted, because minting is owner-gated and the owner is a person with a
 * Google account. Seeding writes the store the daemon reads, inside the container, as root, the same shape of
 * move the browser tier makes when it seeds a signed session cookie instead of signing in to Google. Both are
 * the harness standing in for the one step a machine cannot take, and both are worth naming as such.
 *
 * HOW AN ACCOUNT IS CONNECTED. This is the one thing CI cannot fake, and the tier does not try: connecting an
 * AI account is a subscription OAuth flow through a browser. What it uses instead is the product's own answer
 * to "several sandboxes, one set of credentials", a shared agent-auth VOLUME. Connect an account once, by
 * hand, in the runner's snapshot; every sandbox this tier creates mounts that volume and comes up already
 * connected. Absent the volume the turn stands down NAMING it, exactly as the repo's other gated tiers do:
 * a tier that cannot reach its credential has nothing to say, and must not fail.
 */

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
    /** The container tier 2 brought up. */
    readonly container: string;
    /**
     * A Docker volume holding an already-connected AI account, mounted at /agent-auth by the setup. Absent ⇒
     * the turn stands down naming it, and everything up to the turn still runs.
     */
    readonly agentAuthVolume: string | undefined;
    /** How long one turn may take before this gives up on it. */
    readonly turnSeconds: number;
}

/* The prompt. Deliberately the smallest thing that can only be answered by a model actually running: no tools,
 * no files, one word back. A turn that "worked" because the harness short-circuited it would prove nothing, and
 * a long prompt buys nothing but a slower nightly and more ways to be flaky. */
const PROMPT = `Reply with exactly the word: ready`;
const EXPECTED = `ready`;

const STORE_PATH = `${WORKSPACE_ROOT}/${STATE_DIR}/identity/control-tokens.json`;

/* sha256, computed by the container so the digest is the one that container's own code would compute.
 *
 * Returns what went wrong rather than a bare false: the two steps here fail for entirely different reasons,
 * a container that is gone, and a store the daemon has never written a directory for, and a tier that
 * reported both as "could not seed" once cost a Windows build the one line that would have explained it. */
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
    /* READ IT BACK, because a shell writes an empty file on a heredoc it never saw the end of and calls it a
     * success. The seed's whole payload is one multi-line argument crossing two argument parsers and a shell,
     * and every way that can go wrong lands here as exit 0 with a store the daemon then reads as nothing —
     * which reaches the transcript as `/agents answered 401`, a sentence about the credential rather than about
     * the write. What went in has to come back out, or this says which of the two it was. */
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

/* Spoken from the Windows host over the derived loopback address, the whole point of the tier. `fetch` rather
 * than a curl inside the container: a call made from inside would go through neither the publish nor the host's
 * own network stack, which is exactly the half tier 2 already covered. */
const callDaemon = async (port: number, path: string, token: string | undefined, body?: unknown): Promise<DaemonCall> => {
    const headers: Record<string, string> = { "content-type": `application/json` };
    if (token !== undefined) {
        headers[`x-intentic-control`] = token;
    }
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: body === undefined ? `GET` : `POST`,
        headers,
        // Spread rather than an explicit `undefined`: a GET with a `body` key present at all is a different
        // request to fetch, whatever the value is.
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(60_000),
    });
    return { status: response.status, body: await response.text() };
};

/* WHOSE DAEMON ANSWERS THERE, asked before anything is asked OF it.
 *
 * Every assertion in this tier is about the sandbox tier 2 created, and every one of them up to the credential
 * is satisfied just as well by SOMEBODY ELSE'S sandbox: another one is reachable, correctly gated, and refuses
 * an uncredentialed call in exactly the same words. Only the seeded control token can tell the two apart,
 * because that one is seeded into a container BY NAME — and its refusal then reads as a broken credential
 * rather than as a wrong daemon, which is a sentence about the product where the truth is about the machine.
 *
 * Not hypothetical: the port is derived from the connect token, which this tier holds constant, so every
 * sandbox it has ever created wants this one port. Docker refuses a whole `run` whose `-p` is taken and `ic`
 * answers that by retrying WITHOUT the shortcut (sandbox/connect.rs) rather than failing the setup, so a
 * leftover from an older run answers here while the container under test publishes nothing at all. `docker
 * port` is the question that separates them; teardown removes such a leftover before the tiers begin. */
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

// The gate, asserted before the credential is used, and worth asserting because the failure it guards is
// silent: a daemon that answers everything to everyone looks identical, from every other assertion here, to
// one that is correctly gated. The daemon refuses to boot at all in that state; this proves it did not.
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

    // ── reachable from the host, at the address the browser derives ──────────────────────────────────────
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

    // ── the gate is real ─────────────────────────────────────────────────────────────────────────────────
    await gateIsReal(harness, port);

    // ── the credential a program is meant to use ─────────────────────────────────────────────────────────
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

    // ── one turn ─────────────────────────────────────────────────────────────────────────────────────────
    if (options.agentAuthVolume === undefined) {
        harness.section(`one /agents turn: stood down, no INTENTIC_AGENT_AUTH_VOLUME`);
        harness.pass(`everything up to the turn passed. Connect an AI account once on this machine and name its volume to run the turn too.`);
        return;
    }

    harness.section(`one /agents turn`);
    // Client-minted once, then used for every operation on this conversation. A timestamp or a route response
    // is not the identity: the same stable id keys the turn, registry card, polling read and transcript.
    const conversationId = `windows-smoke-${randomUUID()}`;
    const started = await callDaemon(port, `/agent`, token, { conversationId, prompt: PROMPT, title: `windows smoke` });
    if (started.status !== 200) {
        harness.fail(`starting a turn answered ${started.status}`, started.body.slice(0, 800));
        return;
    }
    harness.pass(`the turn started`);

    /* Poll the conversation's own transcript rather than the fleet roster. The roster is a list of summaries
     * and cannot prove which reply belongs to this turn; the transcript route is keyed by the same identity the
     * POST carried. Require an ASSISTANT bubble equal to the expected answer so the prompt's own word "ready"
     * cannot satisfy the assertion before the model replies. */
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
