import { Request, Response } from "express";
import { AuthService } from "./auth.service";
import { LoginSchema, DemoLoginSchema } from "./auth.schema";
import { demoModeEnabled } from "../../config/env";

export class AuthController {
  static async login(req: Request, res: Response): Promise<void> {
    try {
      const parsed = LoginSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
        return;
      }
      const data = await AuthService.login(parsed.data);
      res.json(data);
    } catch (err: any) {
      res.status(401).json({ error: err.message || "Authentication failed" });
    }
  }

  static async demoLogin(req: Request, res: Response): Promise<void> {
    if (!demoModeEnabled()) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    try {
      const parsed = DemoLoginSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "Invalid persona. Valid options: anika, dev, meera, kabir, neha, farah",
        });
        return;
      }
      const data = await AuthService.demoLogin(parsed.data.persona);
      res.json(data);
    } catch (err: any) {
      res.status(400).json({ error: err.message || "Demo login failed" });
    }
  }

  static async me(req: any, res: Response): Promise<void> {
    res.json({ user: req.user });
  }
}

