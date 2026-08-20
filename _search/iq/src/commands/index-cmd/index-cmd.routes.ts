import { buildCommand, buildRouteMap, type CommandContext } from "@stricli/core";
import { engineFromEnv } from "../../lib/run.js";
import type { IndexStatus } from "@intentic/iq-engine";

const write = (context: CommandContext, status: IndexStatus): void => {
    context.process.stdout.write(
        `iq index: generation ${status.generation} · ${status.files} files · ${status.symbols} symbols · ${status.chunks} chunks (${status.embedded} embedded)\n`,
    );
};

const status = buildCommand({
    docs: { brief: "Revalidate and report index counts" },
    parameters: { flags: {}, positional: { kind: "tuple", parameters: [] } },
    async func(this: CommandContext) {
        write(this, await engineFromEnv().indexStatus());
    },
});

const rebuild = buildCommand({
    docs: { brief: "Drop and rebuild the index from scratch" },
    parameters: { flags: {}, positional: { kind: "tuple", parameters: [] } },
    async func(this: CommandContext) {
        write(this, await engineFromEnv().indexRebuild((message: string) => this.process.stderr.write(`${message}\n`)));
    },
});

const drop = buildCommand({
    docs: { brief: "Delete the on-disk index (it self-rebuilds on next use)" },
    parameters: { flags: {}, positional: { kind: "tuple", parameters: [] } },
    func(this: CommandContext) {
        engineFromEnv().indexDrop();
        this.process.stdout.write("iq index: dropped\n");
    },
});

// Ops escape hatch only, the index self-manages in the happy path.
export const indexCommand = buildRouteMap({
    routes: { status, rebuild, drop },
    docs: { brief: "Index lifecycle (self-managing; use only when results look stale)" },
});
