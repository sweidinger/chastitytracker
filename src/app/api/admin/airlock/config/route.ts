import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/authGuards";
import { getAirlockConfigSafe, saveAirlockConfig } from "@/lib/airlock/config";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/airlock/config — instanzweite Airlock-Verbindung (nie der Key, nur `apiKeySet`).
 * PATCH aktualisiert enabled / baseUrl / apiKey (leerer apiKey löscht den gespeicherten Key).
 * Admin-only wie die AI-Keyholder-Config; Fehler als schlichtes JSON (kein i18n-Registry-Code nötig).
 */
export async function GET() {
  const err = await requireAdminApi();
  if (err) return err;
  return NextResponse.json({ config: await getAirlockConfigSafe() });
}

export async function PATCH(req: Request) {
  const err = await requireAdminApi();
  if (err) return err;

  const body = (await req.json()) as {
    enabled?: boolean;
    baseUrl?: string | null;
    apiKey?: string;
  };

  const patch: { enabled?: boolean; baseUrl?: string | null; apiKey?: string } = {};
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  if ("baseUrl" in body) {
    const v = (body.baseUrl ?? "").trim();
    if (v !== "" && !/^https?:\/\//i.test(v)) {
      return NextResponse.json({ error: "baseUrl muss mit http:// oder https:// beginnen" }, { status: 400 });
    }
    patch.baseUrl = v === "" ? null : v;
  }
  if ("apiKey" in body && body.apiKey !== undefined) patch.apiKey = body.apiKey;

  const config = await saveAirlockConfig(patch);
  return NextResponse.json({ config });
}
