// The one way the agent's asking commands (capabilities, secrets, grants, environment, needs) reach the needs door
// (docs/architecture/needs.md), so every ask answers the same way whichever command raised it:
//
//   exit 0  met: usable now (or already was); the sentence says how
//   exit 1  refused: nothing was raised, or a person declined; the sentence says what to do instead
//   exit 2  error: misuse, transport failure or unreadable answer; no verdict was reached
//   exit 3  open: asked, still waiting; the answer reaches the conversation by itself, so neither poll nor ask again
//
// A raise holds its call up to 90 seconds by default (--wait sets it, 0..100), always under the agent shell's 110-second
// cutoff, so the answer comes back on the call rather than being cut loose into a background window. The daemon, not
// this file, decides everything a card says; the command only carries the agent's words (`--why`, `--where`) and the
// facts it can know (a site, a setting, a tool's steps).
//
// node:http rather than fetch: a held raise keeps its connection for as long as the daemon holds it, and undici's
// default header timeout would drop it first. Auth is the per-boot agent token; auth/grants.ts admits it to the
// agent-facing needs routes, none of which ever returns a credential.

import { readFileSync } from "node:fs";
import { request } from "node:http";

// Overridable so a suite can point a command at a daemon of its own; the image never sets either.
const TOKEN_PATH = process.env.INTENTIC_AGENT_TOKEN_PATH ?? "/run/intentic/agent.token";
const PORT = process.env.SANDBOX_PORT ?? "8787";

// The conversation this shell was spawned for (platform/leftovers.ts workloadStamp): whose chat the card goes in. The
// daemon falls back to the sole live turn when it is unset, and refuses rather than guessing between two.
const CONVERSATION = process.env.INTENTIC_TURN_OWNER ?? "";

export const EXIT_OPEN = 3;

export const WAIT_HELP = `The call holds up to 90 seconds for a person's answer (--wait <0..100> changes that, and an unattended turn never
holds). Exit 0: met, usable now. Exit 1: refused or declined: carry on without it and say what it would have enabled.
Exit 2: no verdict: check the error on stdout and correct the command or restore the daemon before retrying.
Exit 3: asked and still waiting: carry on with what does not need it; the answer reaches this conversation by itself, so
do not poll and do not ask again. \`needs\` lists what is still waiting.`;

export const die = (command, message) => {
    // Agents discard stderr, so a failure must survive on the stream they read.
    process.stdout.write(`${command}: ${message}\n`);
    process.exit(2);
};

// Read lazily: `--help` must work in a shell where the daemon is not running yet.
const token = (command) => {
    try {
        return readFileSync(TOKEN_PATH, "utf8").trim();
    } catch {
        return die(command, `no daemon token at ${TOKEN_PATH}: is the intentic daemon running in this container?`);
    }
};

// One loopback call, held open for as long as the daemon holds it (see the header note).
export const call = (command, method, path, body) =>
    new Promise((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port: PORT, path, method }, (response) => {
            let raw = "";
            response.on("data", (chunk) => {
                raw += chunk.toString();
            });
            response.on("end", () => resolve({ status: response.statusCode ?? 502, text: raw }));
        });
        req.on("error", reject);
        req.setHeader("x-intentic-agent", token(command));
        if (CONVERSATION !== "") {
            req.setHeader("x-intentic-conversation", CONVERSATION);
        }
        if (body !== undefined) {
            req.setHeader("content-type", "application/json");
        }
        req.end(body);
    });

// The daemon's refusals arrive as {message} (oRPC) or {error:{message}} (a raw route): the sentence is already written
// to be acted on.
export const refusalOf = (text) => {
    try {
        const parsed = JSON.parse(text);
        if (typeof parsed?.message === "string") {
            return parsed.message;
        }
        if (typeof parsed?.error === "string") {
            return parsed.error;
        }
        if (typeof parsed?.error?.message === "string") {
            return parsed.error.message;
        }
    } catch {
        // allow(silent-catch): not JSON, the raw text is all there is.
    }
    return text || "the daemon did not say why";
};

// `--name value` flags anywhere after the verb, `--set key=value` repeatable, bare `--flag` switches; what remains is
// positional. Unknown flags fail rather than being read as positionals, so a typo never becomes a card's subject.
export const parseArgs = (command, args, { values = [], switches = [], repeated = [] } = {}) => {
    const flags = {};
    const rest = [];
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (!arg.startsWith("--") || arg === "--") {
            rest.push(arg);
            continue;
        }
        const name = arg.slice(2);
        if (switches.includes(name)) {
            flags[name] = true;
        } else if (values.includes(name) || repeated.includes(name)) {
            const value = args[index + 1];
            if (value === undefined) {
                die(command, `--${name} needs a value`);
            }
            index += 1;
            if (repeated.includes(name)) {
                flags[name] = [...(flags[name] ?? []), value];
            } else {
                flags[name] = value;
            }
        } else {
            die(command, `unknown option --${name}`);
        }
    }
    return { flags, rest };
};

// `--wait` as the route takes it: whole seconds, 0..100.
const waitOf = (command, raw) => {
    if (raw === undefined) {
        return undefined;
    }
    const seconds = Number(raw);
    if (!Number.isInteger(seconds) || seconds < 0 || seconds > 100) {
        return die(command, "--wait takes whole seconds from 0 to 100");
    }
    return seconds;
};

// Raises one ask and exits by how it came back: prints the daemon's sentence, and the need's id when one is open.
export const raise = async (command, ask, flags) => {
    const why = flags.why === undefined || flags.why === "" ? {} : { why: flags.why };
    const wait = waitOf(command, flags.wait);
    const { status, text } = await call(command, "POST", "/needs/ask", JSON.stringify({ ask, ...why, ...(wait === undefined ? {} : { wait }) }));
    if (status < 200 || status >= 300) {
        return die(command, refusalOf(text));
    }
    const answer = JSON.parse(text);
    if (!["met", "open", "refused"].includes(answer?.state) || typeof answer?.message !== "string") {
        return die(command, "unreadable answer from the daemon: expected a need verdict and message");
    }
    process.stdout.write(`${answer.message}\n`);
    process.exit(answer.state === "met" ? 0 : answer.state === "open" ? EXIT_OPEN : 1);
};
