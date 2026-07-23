import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient; __sqlitePragmasSet?: boolean };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["query", "error"] : ["error"],
    datasourceUrl: appendConnectionLimit(process.env.DATABASE_URL ?? ""),
  });

/** Ensures SQLite uses a single connection to prevent SQLITE_BUSY errors. */
function appendConnectionLimit(url: string): string {
  if (!url || url.includes("connection_limit")) return url;
  return url + (url.includes("?") ? "&" : "?") + "connection_limit=1";
}

globalForPrisma.prisma = prisma;

// SQLite unter gleichzeitigem Zugriff (App UND aikh-cron schreiben dieselbe Datei): das WAL-Journal
// entkoppelt Leser von Schreibern und verkuerzt die Schreib-Sperr-Fenster drastisch; busy_timeout
// laesst eine Verbindung auf die Sperre WARTEN statt sofort mit SQLITE_BUSY zu scheitern. journal_mode=WAL
// ist eine persistente Eigenschaft der DB-Datei (einmal gesetzt bleibt es), busy_timeout gilt pro
// Verbindung. Fire-and-forget beim ersten Import — greift fuer JEDEN Prozess, der diesen Singleton nutzt.
if (!globalForPrisma.__sqlitePragmasSet) {
  globalForPrisma.__sqlitePragmasSet = true;
  void (async () => {
    try {
      await prisma.$queryRawUnsafe("PRAGMA journal_mode=WAL;");
      await prisma.$executeRawUnsafe("PRAGMA busy_timeout=15000;");
    } catch {
      /* best-effort — PRAGMA-Fehler duerfen den Start nicht blockieren */
    }
  })();
}
