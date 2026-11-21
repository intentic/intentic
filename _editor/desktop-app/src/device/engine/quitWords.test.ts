import "@intentic/testing/dom";
import { freshImport } from "@intentic/testing/bun";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { registerDesktopCatalog } from "../../i18n";

// The words of the Quit question about a move between engines, handed to the app once per window in the reader's
// language (windows/quit.rs `MoveWords`). The app is Tauri's own IPC mock.

await registerDesktopCatalog();

const load = () => freshImport<typeof import("./quitWords")>("./quitWords", import.meta.url);

let calls: { command: string; args: Record<string, unknown> }[] = [];

beforeEach(() => {
    calls = [];
    mockIPC((command, args) => {
        // SAFETY: the one command this module invokes passes a plain object of named arguments.
        calls.push({ command, args: (args ?? {}) as Record<string, unknown> });
        return null;
    });
});
afterEach(() => clearMocks());

it(`hands the app the question's words once a window, saying the move stops and the sandboxes go back`, async () => {
    const quitWords = await load();
    await quitWords.startQuitWords();
    await quitWords.startQuitWords();
    const told = calls.filter((call) => call.command === `quit_move_words`);
    expect(told).toHaveLength(1);
    const said = told[0]?.args[`words`];
    expect(said).toEqual({
        title: `Stop moving your sandboxes?`,
        message: `Intentic is moving this PC's sandboxes to its own engine right now. If you quit, the move stops, and your sandboxes are put back on Docker Desktop the next time this PC is set up.`,
        wait: `Quit when it's done`,
        quit: `Stop the move and quit`,
        cancel: `Cancel`,
    });
});
