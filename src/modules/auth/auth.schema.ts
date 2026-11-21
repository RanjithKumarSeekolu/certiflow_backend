import { z } from "zod";

export const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

export const DemoLoginSchema = z.object({
  persona: z.enum(["anika", "dev", "meera", "kabir", "neha", "farah"]),
});

export type LoginInput = z.infer<typeof LoginSchema>;
export type DemoLoginInput = z.infer<typeof DemoLoginSchema>;

