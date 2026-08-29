import { z } from "zod";
export const IntenticRunSchema = z.object({ args: z.array(z.string()) });
