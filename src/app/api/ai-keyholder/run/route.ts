import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { runAutonomousAction } from "@/lib/aiKeyholder/keyholderService";

const CRON_SECRET = process.env.AI_KEYHOLDER_CRON_SECRET;

/** Wie lange ein geclaimter Lauf für parallele Aufrufe gesperrt bleibt. Kippt der Lauf (LLM-Timeout,
 *  Absturz), wird nextRunAt nicht überschrieben — der Lauf ist dann nach dieser Frist wieder fällig. */
const CLAIM_LEASE_MIN = 10;

/** Pick a random integer in [min, max] (inclusive). */
function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Schedule the next autonomous run for a user based on their random interval config. */
async function scheduleNextRun(userId: string, minMin: number, maxMin: number): Promise<Date> {
  const delayMs = randomInt(minMin, maxMin) * 60_000;
  const nextRunAt = new Date(Date.now() + delayMs);
  await prisma.aiKeyholderConfig.update({
    where: { userId },
    data: { nextRunAt },
  });
  return nextRunAt;
}

/**
 * POST /api/ai-keyholder/run
 *
 * Cron endpoint — runs the autonomous keyholder agent for all enabled users.
 * Protected by a shared secret (AI_KEYHOLDER_CRON_SECRET env var).
 *
 * The cron container calls this every minute; the route itself decides whether
 * each user's agent is due based on nextRunAt. After running, nextRunAt is set
 * to now + random(randomIntervalMinMin, randomIntervalMinMax) minutes.
 *
 * Pass { userId, force: true } to bypass the timing check (admin "Jetzt ausführen").
 */
export async function POST(req: Request) {
  // Auth: require cron secret header OR valid admin session
  const authHeader = req.headers.get("authorization");
  const providedSecret = authHeader?.replace(/^Bearer\s+/, "");

  const isCron = CRON_SECRET && providedSecret === CRON_SECRET;

  if (!isCron) {
    const { auth } = await import("@/lib/auth");
    const session = await auth();
    if (!session || session.user.role !== "admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const body = await req.json().catch(() => ({})) as { userId?: string; force?: boolean };
  const force = body.force === true;

  // Collect configs to process
  let configs: { userId: string; username: string; nextRunAt: Date | null; randomIntervalMinMin: number | null; randomIntervalMinMax: number | null }[];

  if (body.userId) {
    const cfg = await prisma.aiKeyholderConfig.findUnique({
      where: { userId: body.userId },
      select: {
        userId: true,
        nextRunAt: true,
        randomIntervalMinMin: true,
        randomIntervalMinMax: true,
        user: { select: { username: true } },
      },
    });
    if (!cfg) return NextResponse.json({ error: "User not found or not configured" }, { status: 404 });
    configs = [{ userId: cfg.userId, username: cfg.user.username, nextRunAt: cfg.nextRunAt, randomIntervalMinMin: cfg.randomIntervalMinMin, randomIntervalMinMax: cfg.randomIntervalMinMax }];
  } else {
    const raw = await prisma.aiKeyholderConfig.findMany({
      where: { enabled: true },
      select: {
        userId: true,
        nextRunAt: true,
        randomIntervalMinMin: true,
        randomIntervalMinMax: true,
        user: { select: { username: true } },
      },
    });
    configs = raw.map((c) => ({ userId: c.userId, username: c.user.username, nextRunAt: c.nextRunAt, randomIntervalMinMin: c.randomIntervalMinMin, randomIntervalMinMax: c.randomIntervalMinMax }));
  }

  const now = new Date();
  const results: { userId: string; acted: boolean; summary: string; nextRunAt?: string; skipped?: boolean }[] = [];

  for (const cfg of configs) {
    const minMin = cfg.randomIntervalMinMin ?? 15;
    const maxMin = cfg.randomIntervalMinMax ?? 120;

    // Skip if not yet due (unless forced via admin button)
    if (!force && cfg.nextRunAt && cfg.nextRunAt > now) {
      results.push({
        userId: cfg.userId,
        acted: false,
        summary: `not due yet (next: ${cfg.nextRunAt.toISOString()})`,
        nextRunAt: cfg.nextRunAt.toISOString(),
        skipped: true,
      });
      continue;
    }

    // Lauf ATOMAR claimen, BEVOR das LLM gerufen wird. runAutonomousAction dauert Sekunden bis
    // Minuten (LLM + Bilder), der Cron feuert im Minutentakt — ohne Claim sehen zwei überlappende
    // Aufrufe dasselbe abgelaufene nextRunAt und führen beide aus (doppelte Strafe/Anforderung/Push).
    // updateMany mit nextRunAt-Bedingung ist ein einzelnes UPDATE ⇒ genau einer gewinnt (count===1).
    if (!force) {
      const claim = await prisma.aiKeyholderConfig.updateMany({
        where: {
          userId: cfg.userId,
          OR: [{ nextRunAt: null }, { nextRunAt: { lte: now } }],
        },
        // Provisorischer Platzhalter für die Dauer des Laufs; unten wird er durch das echte
        // Zufalls-Intervall ersetzt. Hält einen parallelen Aufruf so lange draußen.
        data: { nextRunAt: new Date(now.getTime() + CLAIM_LEASE_MIN * 60_000) },
      });
      if (claim.count === 0) {
        results.push({
          userId: cfg.userId,
          acted: false,
          summary: "already claimed by a concurrent run",
          skipped: true,
        });
        continue;
      }
    }

    const result = await runAutonomousAction(cfg.userId, cfg.username);
    const nextRunAt = await scheduleNextRun(cfg.userId, minMin, maxMin);
    results.push({ userId: cfg.userId, ...result, nextRunAt: nextRunAt.toISOString() });
  }

  return NextResponse.json({ processed: results.length, results });
}
