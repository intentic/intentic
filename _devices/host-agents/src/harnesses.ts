import type { NativeProvider } from "@intentic/sandbox-contract/models/provider-specs";
import type { PlaceHost } from "./place.js";

// THE HARNESSES A COMPUTER CAN RUN, and how each one's Agent Client Protocol command is found. A harness is the
// reader's own program with the reader's own sign-in: nothing of Intentic's stands between it and its provider, and
// this package holds no credential. Two shapes:
//
// - `cli`: the harness's own program speaks the protocol (Gemini CLI, Grok Build, Kimi, Devin, OpenCode). It runs only
//   where the reader installed it; nothing here fetches one.
// - `adapter`: the vendor publishes a separate program that speaks the protocol for the harness (Claude Code, Codex).
//   One already on PATH is used; otherwise it is fetched once, at a pinned version, under the reader's home in that
//   place (`~/.intentic/engines/host-agents`), never installed globally. It signs in with the harness's own stored
//   login (`~/.claude`, `~/.codex`), so a reader who already uses the harness in a terminal has nothing to do.
//
// The ids are the contract's provider ids where the harness is one of its native providers, so a card, a model picker
// and a transcript name it as they do in a sandbox.

export interface AdapterSpec {
    // The npm package and the exact version fetched.
    readonly pkg: string;
    readonly version: string;
    // The command a global install puts on PATH.
    readonly bin: string;
    // Where its program is under an install's `node_modules`: a script some JavaScript runtime runs, or a program of
    // the platform's own.
    readonly entry: (place: Pick<PlaceHost, `platform` | `arch`>) => { readonly kind: `script` | `program`; readonly path: readonly string[] };
}

interface HarnessBase {
    readonly label: string;
    readonly cli?: { readonly bin: string; readonly args: readonly string[] };
    readonly adapter?: AdapterSpec;
}

// `native` is one of the contract's native providers (models/provider-specs.ts): the accounts and models routes take
// its id, and a picker names it as it does in a sandbox. Any other harness is listed as an installed ACP agent.
export type HarnessSpec = HarnessBase & ({ readonly native: true; readonly id: NativeProvider } | { readonly native: false; readonly id: string });

// The versions fetched are pinned here and nowhere else: an adapter is the program a turn's every tool call passes
// through, so a new one is taken on purpose, after it has been run, not whenever its vendor publishes.
export const HARNESSES: readonly HarnessSpec[] = [
    {
        id: `claude`,
        label: `Claude Code`,
        native: true,
        adapter: {
            pkg: `@agentclientprotocol/claude-agent-acp`,
            version: `0.111.0`,
            bin: `claude-agent-acp`,
            entry: () => ({ kind: `script`, path: [`@agentclientprotocol`, `claude-agent-acp`, `dist`, `index.js`] }),
        },
    },
    {
        id: `codex`,
        label: `Codex`,
        native: true,
        adapter: {
            pkg: `@zed-industries/codex-acp`,
            version: `0.16.0`,
            bin: `codex-acp`,
            // The package's own launcher only finds this program and starts it; starting it directly needs no runtime.
            entry: ({ platform, arch }) => ({
                kind: `program`,
                path: [`@zed-industries`, `codex-acp-${platform}-${arch}`, `bin`, platform === `win32` ? `codex-acp.exe` : `codex-acp`],
            }),
        },
    },
    { id: `gemini`, label: `Gemini CLI`, native: true, cli: { bin: `gemini`, args: [`--experimental-acp`] } },
    { id: `grok`, label: `Grok Build`, native: true, cli: { bin: `grok`, args: [`agent`, `stdio`] } },
    { id: `kimi`, label: `Kimi Code`, native: true, cli: { bin: `kimi`, args: [`acp`] } },
    { id: `devin`, label: `Devin`, native: true, cli: { bin: `devin`, args: [`acp`] } },
    { id: `opencode`, label: `OpenCode`, native: false, cli: { bin: `opencode`, args: [`acp`] } },
];
