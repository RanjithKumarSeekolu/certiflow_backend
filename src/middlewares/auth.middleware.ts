import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

import { jwtSecret } from "../config/env";

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: "CENTRE" | "DISTRICT_OFFICER" | "QUALITY_TEAM" | "STATE_OFFICE";
  districtId: string | null;
  name: string;
}

export interface AuthRequest extends Request {
  user?: AuthenticatedUser;
}

export function authenticate(req: AuthRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized: Missing or invalid token" });
    return;
  }

  const token = authHeader.split(" ")[1];
  if (!token) {
    res.status(401).json({ error: "Unauthorized: Token missing" });
    return;
  }

  try {
    const payload = jwt.verify(token, jwtSecret()) as unknown as AuthenticatedUser;
    req.user = payload;
    next();
  } catch (err) {
    res.status(401).json({ error: "Unauthorized: Invalid or expired token" });
  }
}

export function requireRole(...roles: string[]) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({
        error: `Forbidden: Step requires role [${roles.join(", ")}], but you have role [${req.user.role}]`,
      });
      return;
    }
    next();
  };
}
