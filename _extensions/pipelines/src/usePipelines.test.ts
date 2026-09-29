import { pipelineRun } from "./testing";
import { fixParams } from "./usePipelines";

// What a Fix press asks of the daemon. The daemon holds no chat pick of its own: a plain press once opened an unpinned
// fix on Claude for an owner whose only provider was Z.ai, while the button named the model a new chat would open on.

const run = pipelineRun({ runId: 41 });
const standing = { provider: `zai`, model: `glm-4.6`, label: `GLM-4.6` };

describe(`a Fix press`, () => {
    it(`sends the model its button names as the fallback, which a model pinned for the job still outranks daemon-side`, () => {
        expect(fixParams({ run, standing })).toEqual({ repo: `web`, runId: 41, fallback: { agent: `zai`, model: `glm-4.6` } });
    });

    // A provider whose catalog has not loaded names no model yet: an empty one is bad input the sandbox refuses the whole
    // press for, where with none it opens on its own default.
    it(`sends no fallback while the chat default names no model`, () => {
        expect(fixParams({ run, standing: { ...standing, model: `` } })).toEqual({ repo: `web`, runId: 41 });
    });

    it(`sends a model chosen at the caret as the pick, and no fallback beside it`, () => {
        const pick = { provider: `codex`, model: `gpt-5.1-codex`, label: `GPT-5.1 Codex`, effort: `high` };

        expect(fixParams({ run, pick, mode: `start-over`, standing })).toEqual({
            repo: `web`,
            runId: 41,
            pick: { agent: `codex`, model: `gpt-5.1-codex`, effort: `high` },
            mode: `start-over`,
        });
    });
});
