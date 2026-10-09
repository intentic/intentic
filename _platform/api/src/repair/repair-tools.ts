// Repair's tool schema lives here only: the desktop app executes what the model asks, never widens this list.

export const REPAIR_TOOL_NAMES = [
    `doctor`,
    `engine_status`,
    `pc_check`,
    `sandbox_list`,
    `sandbox_logs`,
    `setup_log`,
    `fix`,
    `engine_start`,
    `sandbox_restart`,
    `sandbox_rollback`,
] as const;

export type RepairToolName = (typeof REPAIR_TOOL_NAMES)[number];

/** OpenAI-shaped tool definitions the model sees; mutating tools are described as needing the reader's Allow on the PC. */
export const repairToolDefinitions = (): readonly Record<string, unknown>[] =>
    [
        {
            type: `function`,
            function: {
                name: `doctor`,
                description: `Read-only: run ic sandbox doctor for one sandbox or every sandbox on this PC.`,
                parameters: {
                    type: `object`,
                    properties: {
                        slug: { type: `string`, description: `Sandbox slug, or omit for every sandbox on this PC.` },
                    },
                },
            },
        },
        {
            type: `function`,
            function: {
                name: `engine_status`,
                description: `Read-only: ic engine status --json for the container engine on this PC.`,
                parameters: { type: `object`, properties: {} },
            },
        },
        {
            type: `function`,
            function: {
                name: `pc_check`,
                description: `Read-only: ic docker prepare --dry-run summary for this PC (WSL, engine, disk, memory).`,
                parameters: { type: `object`, properties: {} },
            },
        },
        {
            type: `function`,
            function: {
                name: `sandbox_list`,
                description: `Read-only: list every sandbox on this PC (ic sandbox list --json).`,
                parameters: { type: `object`, properties: {} },
            },
        },
        {
            type: `function`,
            function: {
                name: `sandbox_logs`,
                description: `Read-only: tail recent logs for one sandbox (bounded).`,
                parameters: {
                    type: `object`,
                    properties: {
                        slug: { type: `string`, description: `Sandbox slug.` },
                        lines: { type: `integer`, description: `How many lines, at most 80.` },
                    },
                    required: [`slug`],
                },
            },
        },
        {
            type: `function`,
            function: {
                name: `setup_log`,
                description: `Read-only: the app's last PC setup transcript (bounded).`,
                parameters: { type: `object`, properties: {} },
            },
        },
        {
            type: `function`,
            function: {
                name: `fix`,
                description: `Changes something: ic sandbox fix for a slug. The reader must Allow on the PC first.`,
                parameters: {
                    type: `object`,
                    properties: {
                        slug: { type: `string` },
                        code: { type: `string`, description: `Optional fix code from the recovery panel.` },
                    },
                    required: [`slug`],
                },
            },
        },
        {
            type: `function`,
            function: {
                name: `engine_start`,
                description: `Changes something: ic engine start. The reader must Allow on the PC first.`,
                parameters: { type: `object`, properties: {} },
            },
        },
        {
            type: `function`,
            function: {
                name: `sandbox_restart`,
                description: `Changes something: restart a sandbox on this PC. The reader must Allow on the PC first.`,
                parameters: {
                    type: `object`,
                    properties: { slug: { type: `string` } },
                    required: [`slug`],
                },
            },
        },
        {
            type: `function`,
            function: {
                name: `sandbox_rollback`,
                description: `Changes something: roll a sandbox back to its previous image. The reader must Allow on the PC first.`,
                parameters: {
                    type: `object`,
                    properties: { slug: { type: `string` } },
                    required: [`slug`],
                },
            },
        },
    ] as const;

export const REPAIR_SYSTEM_PROMPT = `You are Repair, an assistant that runs in the Intentic desktop app on the reader's PC, outside their workspace sandbox.

You may only diagnose and fix Intentic itself (sandboxes, the container engine, WSL setup). You cannot read or edit the reader's project files and you have no shell.

Use the tools provided. Read-only tools run immediately. Tools that change something (fix, engine_start, sandbox_restart, sandbox_rollback) only run after the reader taps Allow on this PC — explain what you want to do and why before calling them.

Keep answers short and plain. When something is broken, say what you found and the smallest safe fix first.`;
