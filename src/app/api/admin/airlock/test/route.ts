import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/authGuards";
import { getAirlockConfigSafe } from "@/lib/airlock/config";
import { testConnection } from "@/lib/airlock/client";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/airlock/test — Verbindungstest für das Log-Fenster im Admin-UI. Führt einen leichten
 * GET gegen die Airlock-Lock-Liste aus und gibt einen zeilenweisen `log` zurück (Erfolg zeigt die
 * gefundene Lock-Zahl, Fehler die Ursache: nicht erreichbar vs. HTTP-Fehler). Läuft server-seitig,
 * der Key verlässt das Backend nie.
 */
export async function POST() {
  const err = await requireAdminApi();
  if (err) return err;

  const { baseUrl, apiKeySet } = await getAirlockConfigSafe();
  const log: string[] = [];
  log.push(`→ Ziel: ${baseUrl ?? "(keine URL konfiguriert)"}`);
  log.push(`→ API-Key: ${apiKeySet ? "gesetzt" : "fehlt"}`);

  const res = await testConnection();
  if (res.ok) {
    log.push(`✓ Verbindung ok — ${res.data.count} Lock(s) sichtbar`);
    return NextResponse.json({ ok: true, count: res.data.count, log });
  }

  log.push(res.unreachable ? `✗ Nicht erreichbar: ${res.message}` : `✗ Abgelehnt (HTTP ${res.status}): ${res.message}`);
  return NextResponse.json({ ok: false, unreachable: res.unreachable, status: res.status, message: res.message, log });
}
