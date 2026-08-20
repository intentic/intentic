import { z } from "zod";
import type { ContributionPoint } from "../contribution-point.js";

// A checkout-relative directory of executables the daemon prepends to the AGENT's PATH each turn, how an
// extension ships a command-line tool for the agent (the CLI-tools path). The files ARE the approved code (they
// ride the sha-pinned checkout); the daemon only adds the dir to PATH.
export const binPoint = {
    name: "bin",
    description:
        "A checkout-relative directory of executables the daemon puts on the agent's PATH every turn — how you ship the agent a command-line tool. The files are the approved code themselves: they ride the pinned checkout, and the daemon only adds the directory to PATH.",
    schema: z
        .string()
        .min(1)
        .refine((value) => !value.split("/").includes(".."), { message: "bin must stay inside the checkout" }),
} as const satisfies ContributionPoint;
