import "@intentic/testing/dom";
import { freshImport } from "@intentic/testing/bun";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { DockerStart } from "../desktop";

// A start of the engine pressed from a folder window's card (host.ts `act`), where the Docker card is not drawn: a start
// that did not bring the engine up rejects with the card's own words for how it ended, so the card under the press says
// it. The app is Tauri's own IPC mock; no catalog is registered, so each message reads back as its own key.

// The kit's device readout (reached through ./machine) asks media queries at import; nothing here is about the screen.
Object.defineProperty(window, `matchMedia`, {
    value: (query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }),
    configurable: true,
});

const load = () => freshImport<typeof import("./docker")>("./docker", import.meta.url);

let answer: DockerStart = { outcome: `ready`, detail: `` };
let calls: string[] = [];

beforeEach(() => {
    calls = [];
    mockIPC((command) => {
        calls.push(command);
        switch (command) {
            case `docker_start`:
                return answer;
            case `docker_listening`:
                return answer.outcome === `ready`;
            case `sandbox_list`:
            case `machine_agents`:
                return [];
            default:
                return null;
        }
    });
});
afterEach(() => clearMocks());

it(`rejects with how the start ended when the engine did not come up, and keeps the card's report`, async () => {
    const docker = await load();
    answer = { outcome: `wouldNotStart`, detail: `Docker Desktop exited` };
    const said = await docker.startDockerAndSay().then(
        () => `went through`,
        (error: unknown) => (error instanceof Error ? error.message : `not an Error`),
    );
    expect([said, docker.dockerReport.value, calls.includes(`machine_sandbox_check`)]).toEqual([
        `desktop.docker.dockerWouldntStart. desktop.docker.tryOpeningItYourself`,
        answer,
        false,
    ]);
});

it(`resolves once the engine is up, and has this computer's sandbox look again`, async () => {
    const docker = await load();
    answer = { outcome: `ready`, detail: `` };
    await docker.startDockerAndSay();
    expect([docker.dockerReport.value?.outcome, calls.includes(`machine_sandbox_check`)]).toEqual([`ready`, true]);
});
