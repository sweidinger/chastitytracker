import { prisma } from "@/lib/prisma";
import type { ServiceResult } from "@/lib/serviceResult";
import { plugCategoryId } from "@/lib/deviceCategories";
import { createVerschlussAnforderung } from "@/lib/verschlussAnforderungService";
import { createOrgasmusAnforderung } from "@/lib/orgasmusAnforderungService";
import { requestKontrolle } from "@/lib/kontrolleService";
import { denyReward, delayReward } from "@/lib/belohnung";

/**
 * Phase 3: Straf-AKTIONEN — eine als Strafe gewählte Maßnahme wird direkt ausgeführt (nicht nur
 * als Text festgehalten). Geteilt von der Admin-Strafe-Route und dem MCP judge_offense.
 * Jede Aktion nutzt die bestehenden Services (keine Sonderpfade).
 */
export type PenaltyActionType =
  | "extend_lock"
  | "ruined_orgasm"
  | "mandatory_session"
  | "bigger_plug"
  | "extra_control"
  | "deny_orgasm"
  | "delay_orgasm";

export interface PenaltyAction {
  type: PenaltyActionType;
  /** extend_lock: Stunden, um die die Sperrzeit verlängert wird (Pflicht). */
  hours?: number;
  /** ruined_orgasm / mandatory_session: Fenster- bzw. Fristdauer in Stunden (Default 24). */
  windowHours?: number;
  // ── ruined_orgasm ──
  /** Öffnen erlaubt, um den (ruinierten) Orgasmus im Fenster durchzuführen. */
  oeffnenErlaubt?: boolean;
  // ── mandatory_session ──
  /** Session-Kategorie (Default: erste Session-Kategorie des Subs). */
  categoryId?: string;
  /** Mindest-/Zieldauer der Session in Minuten. */
  minMinuten?: number;
  /** Verzögerte Auslösung in Minuten (erst ab). */
  delayMinutes?: number;
  /** Bestimmtes Gerät der Kategorie (null = beliebig). */
  deviceId?: string;
  /** Nachweis (Video/Foto) beim Beenden verpflichtend. */
  requireVideo?: boolean;
  // ── extend_lock ──
  /** Reinigungspausen während der (neuen) Sperrzeit weiter erlaubt. */
  reinigungErlaubt?: boolean;
  /** Toilettenpausen während der (neuen) Sperrzeit weiter erlaubt. */
  toiletteErlaubt?: boolean;
  // ── bigger_plug ──
  /** Mindest-Tragedauer des Plugs in Stunden. */
  dauerH?: number;
  /** Frist zum Anlegen des Plugs in Stunden. */
  fristH?: number;
  // ── extra_control ──
  /** Zu kontrollierendes Gerät (CAGE/PLUG, null = allgemein). */
  device?: "CAGE" | "PLUG";
  /** Frist der Kontrolle in Stunden (Default 4). */
  deadlineH?: number;
  /** Frischer handschriftlicher Code im Foto verpflichtend (Default true). */
  requireCode?: boolean;
}

const DEFAULT_WINDOW_H = 24;
const RUINED_ORGASM_ART = "ruinierter Orgasmus";

/** Führt eine Straf-Aktion aus. Gibt eine kurze Beschreibung zurück (für Log/Antwort). */
export async function executePenaltyAction(userId: string, action: PenaltyAction): Promise<ServiceResult<{ message: string }>> {
  const now = new Date();
  switch (action.type) {
    case "extend_lock": {
      const hours = Number(action.hours);
      if (!Number.isFinite(hours) || hours <= 0) return { ok: false, status: 400, error: "Stunden (hours > 0) für Sperrzeit-Verlängerung erforderlich" };
      // Aktive Sperrzeit verlängern, sonst eine neue anlegen.
      const active = await prisma.verschlussAnforderung.findFirst({
        where: { userId, art: "SPERRZEIT", withdrawnAt: null, OR: [{ endetAt: null }, { endetAt: { gt: now } }] },
        orderBy: { endetAt: "desc" },
      });
      if (active && active.endetAt === null) {
        return { ok: true, data: { message: "Sperrzeit ist bereits unbefristet — keine Verlängerung nötig." } };
      }
      if (active && active.endetAt) {
        const neu = new Date(active.endetAt.getTime() + hours * 60 * 60 * 1000);
        await prisma.verschlussAnforderung.update({
          where: { id: active.id },
          data: {
            endetAt: neu,
            ...(action.reinigungErlaubt !== undefined ? { reinigungErlaubt: Boolean(action.reinigungErlaubt) } : {}),
            ...(action.toiletteErlaubt !== undefined ? { toiletteErlaubt: Boolean(action.toiletteErlaubt) } : {}),
          },
        });
        return { ok: true, data: { message: `Sperrzeit um ${hours} h verlängert (neu bis ${neu.toISOString()}).` } };
      }
      const res = await createVerschlussAnforderung({
        userId, art: "SPERRZEIT", endetAt: new Date(now.getTime() + hours * 60 * 60 * 1000), nachricht: "Strafe: Sperrzeit",
        reinigungErlaubt: Boolean(action.reinigungErlaubt), toiletteErlaubt: Boolean(action.toiletteErlaubt),
      });
      if (!res.ok) return res;
      return { ok: true, data: { message: `Neue Sperrzeit über ${hours} h angelegt.` } };
    }
    case "ruined_orgasm": {
      const windowH = action.windowHours && action.windowHours > 0 ? action.windowHours : DEFAULT_WINDOW_H;
      const res = await createOrgasmusAnforderung({
        userId, art: "ANWEISUNG", vorgegebeneArt: RUINED_ORGASM_ART, istStrafe: true,
        oeffnenErlaubt: Boolean(action.oeffnenErlaubt),
        beginntAt: now, endetAt: new Date(now.getTime() + windowH * 60 * 60 * 1000),
        nachricht: "Strafe: ruinierter Orgasmus (Pflicht)",
      });
      if (!res.ok) return res;
      return { ok: true, data: { message: `Ruinierter Orgasmus als Pflicht angeordnet (Fenster ${windowH} h).` } };
    }
    case "mandatory_session": {
      const windowH = action.windowHours && action.windowHours > 0 ? action.windowHours : DEFAULT_WINDOW_H;
      // Kategorie: explizit gewählt (validieren) oder erste Session-Kategorie.
      const cat = action.categoryId
        ? await prisma.deviceCategory.findFirst({ where: { id: action.categoryId, userId, isSessionCategory: true }, select: { id: true, name: true, maxSessionMinutes: true, requiresVideo: true } })
        : await prisma.deviceCategory.findFirst({ where: { userId, isSessionCategory: true }, orderBy: { sortOrder: "asc" }, select: { id: true, name: true, maxSessionMinutes: true, requiresVideo: true } });
      if (!cat) return { ok: false, status: 400, error: action.categoryId ? "Ungültige Session-Kategorie" : "Keine Session-fähige Kategorie vorhanden" };
      // Gerät der Kategorie (optional) validieren.
      let deviceId: string | null = null;
      if (action.deviceId) {
        const dev = await prisma.device.findFirst({ where: { id: action.deviceId, userId, categoryId: cat.id, archivedAt: null }, select: { id: true } });
        deviceId = dev?.id ?? null;
      }
      const minMin = action.minMinuten && action.minMinuten > 0 ? Math.min(Math.round(action.minMinuten), cat.maxSessionMinutes) : null;
      const wirksamAb = action.delayMinutes && action.delayMinutes > 0 ? new Date(now.getTime() + action.delayMinutes * 60 * 1000) : null;
      const startBase = wirksamAb ? wirksamAb.getTime() : now.getTime();
      await prisma.sessionAnforderung.create({
        data: {
          userId, deviceCategoryId: cat.id, nachricht: "Strafe: Pflicht-Session", istStrafe: true,
          endetAt: new Date(startBase + windowH * 60 * 60 * 1000),
          minMinuten: minMin,
          requireVideo: Boolean(action.requireVideo) || cat.requiresVideo,
          wirksamAb, deviceId,
        },
      });
      return { ok: true, data: { message: `Pflicht-Session (${cat.name}) angefordert (Frist ${windowH} h).` } };
    }
    case "bigger_plug": {
      const plugCat = plugCategoryId(userId);
      // Aktuell/zuletzt getragenen Plug ermitteln → dessen Reihenfolge.
      const lastWear = await prisma.entry.findFirst({
        where: { userId, type: "WEAR_BEGIN", device: { categoryId: plugCat } },
        orderBy: { startTime: "desc" },
        include: { device: { select: { sortOrder: true, name: true } } },
      });
      const currentOrder = lastWear?.device?.sortOrder ?? -1;
      const next = await prisma.device.findFirst({
        where: { userId, categoryId: plugCat, archivedAt: null, sortOrder: { gt: currentOrder } },
        orderBy: { sortOrder: "asc" },
      });
      if (!next) return { ok: false, status: 400, error: "Kein nächstgrößerer Plug vorhanden (Reihenfolge in den Geräten setzen)." };
      const res = await createVerschlussAnforderung({
        userId, art: "ANFORDERUNG", deviceCategoryId: plugCat, deviceId: next.id, nachricht: "Strafe: nächstgrößeren Plug tragen",
        ...(action.dauerH && action.dauerH > 0 ? { dauerH: action.dauerH } : {}),
        ...(action.fristH && action.fristH > 0 ? { fristH: action.fristH } : {}),
      });
      if (!res.ok) return res;
      const plugExtra = [
        action.dauerH && action.dauerH > 0 ? `Mindest-Tragedauer ${action.dauerH} h` : null,
        action.fristH && action.fristH > 0 ? `Frist ${action.fristH} h` : null,
      ].filter(Boolean).join(", ");
      return { ok: true, data: { message: `Nächstgrößeren Plug angefordert: ${next.name}${plugExtra ? ` (${plugExtra})` : ""}.` } };
    }
    case "extra_control": {
      const res = await requestKontrolle({
        userId, kommentar: "Strafe: zusätzliche Kontrolle",
        device: action.device ?? null,
        ...(action.deadlineH && action.deadlineH > 0 ? { deadlineH: action.deadlineH } : {}),
        requireCode: action.requireCode !== undefined ? Boolean(action.requireCode) : true,
      });
      if (!res.ok) return res;
      return { ok: true, data: { message: "Zusätzliche Kontrolle angefordert." } };
    }
    case "deny_orgasm": {
      const res = await denyReward(userId);
      if (!res.ok) return res;
      return { ok: true, data: { message: `Orgasmus-Entzug: Belohnungs-Guthaben −1 (neu: ${res.data.available}).` } };
    }
    case "delay_orgasm": {
      const hours = Number(action.hours);
      const res = await delayReward(userId, hours);
      if (!res.ok) return res;
      return { ok: true, data: { message: `Belohnungs-Gelegenheit um ${hours} h verschoben (neu bis ${res.data.endetAt.toISOString()}).` } };
    }
    default:
      return { ok: false, status: 400, error: "Unbekannte Straf-Aktion" };
  }
}
