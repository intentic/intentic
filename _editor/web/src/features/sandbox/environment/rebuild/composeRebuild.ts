// WHAT A REBUILD IS FOR A SANDBOX DOCKER COMPOSE RUNS (SANDBOX_MANAGER). `ic`'s swap would start a container Compose
// does not know, and its one-liner may not even be runnable where Compose lives (Komodo, Portainer, a NAS panel). The
// container is whatever Compose's file says it is, so the rebuild is an edit to that file followed by Compose's own
// redeploy, and this works out the edit from the approved recipe:
//
// - its runtime directives (`# intentic:runtime …`) as the service keys that grant the same thing;
// - its build steps, when it has any beyond the base, as a `build:` that Compose builds on `up` (no steps, no build:
//   the base image already is the environment, as with the docker capability on a standard image);
// - SANDBOX_ENVIRONMENT_HASH, the variable `ic` stamps on a container it built, which is how the sandbox knows it runs
//   this recipe (rebuildPending): without it the card would keep asking after the redeploy did its job.

import { RUNTIME_DIRECTIVE_PREFIX, SANDBOX_CAPABILITIES, runtimeDirectivesOf } from "@intentic/sandbox-run";

export interface ComposeRebuild {
    // Lines for the sandbox's service, indented as its keys (four spaces under `services:` → the service).
    readonly snippet: string;
    // `SANDBOX_ENVIRONMENT_HASH=<hash>`, for the service's environment, in whichever style the file already uses.
    readonly hashEnv: string;
    // Whether the recipe has steps to build; when it has none, the edit is only the service's privileges and the hash.
    readonly builds: boolean;
}

// The service keys each allowlisted directive becomes (RUNTIME_DIRECTIVES). NET_ADMIN is said as the whole list, since
// the file already holds a `cap_add` and two of the same key is not YAML.
const directiveKeys = (token: string): string[] => {
    switch (token) {
        case `--privileged`:
            return [`privileged: true`];
        case `--cap-add=NET_ADMIN`:
            return [`cap_add: [${[...SANDBOX_CAPABILITIES, `NET_ADMIN`].join(`, `)}]`];
        case `--device=/dev/net/tun`:
            return [`devices: ["/dev/net/tun:/dev/net/tun"]`];
        case `--gpus=all`:
            return [`gpus: all`];
        default:
            return [];
    }
};

// A line that builds something: not blank, not a comment (directives are comments too), not the base's FROM.
const isStep = (line: string): boolean => {
    const trimmed = line.trim();
    return trimmed !== `` && !trimmed.startsWith(`#`) && !/^FROM\s/iu.test(trimmed);
};

// A recipe the daemon composed holds only allowlisted directives; one that does not (a hand edit) still gets the
// rest of its edit rather than none.
const directivesOf = (content: string): string[] => {
    try {
        return runtimeDirectivesOf(content);
    } catch {
        return content
            .split(`\n`)
            .filter((line) => line.startsWith(RUNTIME_DIRECTIVE_PREFIX))
            .flatMap((line) => line.slice(RUNTIME_DIRECTIVE_PREFIX.length).trim().split(/\s+/u));
    }
};

const SERVICE_INDENT = `    `;

// Pure: the edit for one approved recipe. `$` is doubled inside the inline Dockerfile, or Compose would read the
// recipe's own shell (`$(node -p …)`) as variables of its file and build something else.
export const composeRebuildOf = (hash: string, content: string): ComposeRebuild => {
    const keys = directivesOf(content).flatMap(directiveKeys);
    const builds = content.split(`\n`).some(isStep);
    const build = builds
        ? [
              `# In place of image: Compose builds this on up.`,
              `image: intentic-sandbox-environment:${hash.replace(/^sha256:/u, ``).slice(0, 12)}`,
              `pull_policy: build`,
              `build:`,
              `    # Base updates arrive with each build.`,
              `    pull: true`,
              `    dockerfile_inline: |`,
              ...content
                  .trimEnd()
                  .split(`\n`)
                  .map((line) => (line === `` ? `` : `        ${line.replaceAll(`$`, `$$$$`)}`)),
          ]
        : [];
    return {
        snippet: [...keys, ...build].map((line) => (line === `` ? `` : `${SERVICE_INDENT}${line}`)).join(`\n`),
        hashEnv: `SANDBOX_ENVIRONMENT_HASH=${hash}`,
        builds,
    };
};
