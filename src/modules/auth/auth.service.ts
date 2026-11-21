import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import prisma from "../../config/db";
import { LoginInput } from "./auth.schema";

import { jwtSecret } from "../../config/env";

export class AuthService {
  static generateToken(user: { id: string; email: string; role: string; districtId: string | null; name: string }) {
    return jwt.sign(
      {
        id: user.id,
        email: user.email,
        role: user.role,
        districtId: user.districtId,
        name: user.name,
      },
      jwtSecret(),
      { expiresIn: "7d" }
    );
  }

  static async login(input: LoginInput) {
    const user = await prisma.user.findUnique({
      where: { email: input.email },
      include: { district: true, centres: true },
    });

    if (!user) {
      throw new Error("Invalid credentials");
    }

    const isValid = await bcrypt.compare(input.password, user.passwordHash);
    if (!isValid) {
      throw new Error("Invalid credentials");
    }

    const token = this.generateToken(user);

    return {
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        districtId: user.districtId,
        district: user.district,
        centres: user.centres,
      },
    };
  }

  static async demoLogin(persona: "anika" | "dev" | "meera" | "kabir" | "neha" | "farah") {
    const emailMap: Record<string, string> = {
      anika: "anika@skills.pragati.gov.in",
      dev: "dev@district.pragati.gov.in",
      meera: "meera@district.pragati.gov.in",
      kabir: "kabir@district.pragati.gov.in",
      neha: "neha@quality.pragati.gov.in",
      farah: "farah@state.pragati.gov.in",
    };

    const email = emailMap[persona];
    if (!email) throw new Error("Unknown demo persona");

    const user = await prisma.user.findUnique({
      where: { email },
      include: { district: true, centres: true },
    });

    if (!user) {
      throw new Error(`Demo persona user ${email} not seeded yet. Please run database seed.`);
    }

    const token = this.generateToken(user);

    return {
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        districtId: user.districtId,
        district: user.district,
        centres: user.centres,
      },
    };
  }
}

