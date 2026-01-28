import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __aurora_prisma__: PrismaClient | undefined;
}

export const prisma =
  globalThis.__aurora_prisma__ ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalThis.__aurora_prisma__ = prisma;

