import { PrismaClient, Role } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  console.log("🌱 Starting database seed...");

  const defaultPassword = await bcrypt.hash("Password123!", 10);

  // 1. Create Districts
  const centralDistrict = await prisma.district.upsert({
    where: { code: "DIST-01" },
    update: {},
    create: {
      name: "Central District",
      code: "DIST-01",
    },
  });

  const northDistrict = await prisma.district.upsert({
    where: { code: "DIST-02" },
    update: {},
    create: {
      name: "North District",
      code: "DIST-02",
    },
  });

  // 2. Create Demo Users
  // Anika (Training Centre)
  const anika = await prisma.user.upsert({
    where: { email: "anika@skills.pragati.gov.in" },
    update: { districtId: centralDistrict.id },
    create: {
      name: "Anika Sharma",
      email: "anika@skills.pragati.gov.in",
      passwordHash: defaultPassword,
      role: Role.CENTRE,
      districtId: centralDistrict.id,
    },
  });

  // Dev (District Officer 1)
  const dev = await prisma.user.upsert({
    where: { email: "dev@district.pragati.gov.in" },
    update: { districtId: centralDistrict.id },
    create: {
      name: "Dev Patel",
      email: "dev@district.pragati.gov.in",
      passwordHash: defaultPassword,
      role: Role.DISTRICT_OFFICER,
      districtId: centralDistrict.id,
    },
  });

  // Meera (District Officer 2)
  const meera = await prisma.user.upsert({
    where: { email: "meera@district.pragati.gov.in" },
    update: { districtId: centralDistrict.id },
    create: {
      name: "Meera Nair",
      email: "meera@district.pragati.gov.in",
      passwordHash: defaultPassword,
      role: Role.DISTRICT_OFFICER,
      districtId: centralDistrict.id,
    },
  });

  // Kabir (District Officer 3)
  const kabir = await prisma.user.upsert({
    where: { email: "kabir@district.pragati.gov.in" },
    update: { districtId: centralDistrict.id },
    create: {
      name: "Kabir Khan",
      email: "kabir@district.pragati.gov.in",
      passwordHash: defaultPassword,
      role: Role.DISTRICT_OFFICER,
      districtId: centralDistrict.id,
    },
  });

  // Neha (Quality Team)
  const neha = await prisma.user.upsert({
    where: { email: "neha@quality.pragati.gov.in" },
    update: {},
    create: {
      name: "Neha Gupta",
      email: "neha@quality.pragati.gov.in",
      passwordHash: defaultPassword,
      role: Role.QUALITY_TEAM,
    },
  });

  // Farah (State Office)
  const farah = await prisma.user.upsert({
    where: { email: "farah@state.pragati.gov.in" },
    update: {},
    create: {
      name: "Farah Sheikh",
      email: "farah@state.pragati.gov.in",
      passwordHash: defaultPassword,
      role: Role.STATE_OFFICE,
    },
  });

  // 3. Create Training Centre for Anika
  const trainingCentre = await prisma.trainingCentre.upsert({
    where: { code: "TC-CENTRAL-01" },
    update: { userId: anika.id, districtId: centralDistrict.id },
    create: {
      name: "Pragati Skill Center Central",
      code: "TC-CENTRAL-01",
      districtId: centralDistrict.id,
      userId: anika.id,
    },
  });

  console.log("✅ Seed completed successfully!");
  console.log("Demo Personas available:");
  console.log(" - Anika (Training Centre): anika@skills.pragati.gov.in / Password123!");
  console.log(" - Dev (District Officer): dev@district.pragati.gov.in / Password123!");
  console.log(" - Meera (District Officer): meera@district.pragati.gov.in / Password123!");
  console.log(" - Kabir (District Officer): kabir@district.pragati.gov.in / Password123!");
  console.log(" - Neha (Quality Team): neha@quality.pragati.gov.in / Password123!");
  console.log(" - Farah (State Office): farah@state.pragati.gov.in / Password123!");
}

main()
  .catch((e) => {
    console.error("❌ Seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

