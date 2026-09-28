import type { SshKey } from "@intentic/sandbox-contract";
import { sandboxRpc } from "../../sandbox/client/sandboxRpc";

// Asks the sandbox for a key pair. The answer is the public half and a token standing in for the private one, which
// never leaves the sandbox. Its own module, so a test can answer it without a daemon.
export const generateSshKey = (): Promise<SshKey> => sandboxRpc.capabilities.sshKey();
