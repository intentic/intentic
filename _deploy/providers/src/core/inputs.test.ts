import type { SshBlock } from "@intentic/graph";
import type { z } from "zod";
import { sshSchema } from "./inputs.js";

// What every SSHing provider parses is the block the resolver emits (@intentic/graph's SshBlock), its key filled in:
// assignable both ways, so a field added to one and not the other fails the type check here.
test("the parsed SSH block is the resolver's block with its key resolved", () => {
    const parsed: SshBlock<string> = sshSchema.parse({ address: "10.0.0.2", user: "ops", sshKey: "key" });
    const emitted: SshBlock<string> = { address: "10.0.0.2", user: "ops", sshKey: "key", port: 22, via: "direct" };
    const back: z.input<typeof sshSchema> = emitted;
    expect(parsed).toEqual(emitted);
    expect(back.via).toBe("direct");
    expect(sshSchema.safeParse({ ...emitted, via: "telnet" }).success).toBe(false);
});
