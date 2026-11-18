import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { APP_TZ, getMidnightToday } from "@/lib/utils";

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const userId = session.user.id;
  const tz = session.user.timezone ?? APP_TZ;
  const datum = getMidnightToday(new Date(), tz);

  const entry = await prisma.tagesform.findUnique({
    where: { userId_datum: { userId, datum } },
    select: { id: true, erregung: true, koerper: true, headspace: true, notiz: true, updatedAt: true },
  });

  return NextResponse.json(entry ?? null);
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const userId = session.user.id;
  const tz = session.user.timezone ?? APP_TZ;

  const body = await req.json();
  const { erregung, koerper, headspace, notiz } = body;

  for (const [key, val] of [["erregung", erregung], ["koerper", koerper], ["headspace", headspace]] as [string, unknown][]) {
    if (typeof val !== "number" || !Number.isInteger(val) || val < 1 || val > 5) {
      return NextResponse.json({ error: `${key} muss 1–5 sein` }, { status: 400 });
    }
  }

  const datum = getMidnightToday(new Date(), tz);

  const entry = await prisma.tagesform.upsert({
    where: { userId_datum: { userId, datum } },
    create: { userId, datum, erregung, koerper, headspace, notiz: notiz ?? null },
    update: { erregung, koerper, headspace, notiz: notiz ?? null },
    select: { id: true, erregung: true, koerper: true, headspace: true, notiz: true, updatedAt: true },
  });

  return NextResponse.json(entry);
}
