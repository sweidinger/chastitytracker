import { formatDuration } from "@/lib/utils";

export interface SessionEvent {
  type: "verschluss" | "kontrolle" | "orgasmus" | "reinigung";
  time: Date;
  imageUrl: string | null;
  /** Bildersafe (VERSCHLUSS): versiegeltes Schlüsselbox-Code-Foto. Sichtbarkeit entscheidet der Server (403-Gate). */
  codeImageUrl?: string | null;
  imageExifTime: Date | null;
  note: string | null;
  entryId: string | null;
  deadline?: Date | null;
  kontrolleKommentar?: string | null;
  kontrolleCode?: string | null;
  kontrolleAnforderungStatus?: string | null;
  kontrolleVerifikationStatus?: string | null;
  orgasmusArt?: string | null;
  pauseDurationStr?: string | null;
  submittedAt?: Date | null;
  /** Für "reinigung"-Events (Plug-Pausen): der konkrete Grund (REINIGUNG/TOILETTE) für ein korrektes Pill-Label. */
  reinigungGrund?: string | null;
}

type ActivePair = {
  verschluss: { id: string; startTime: Date; imageUrl: string | null; codeImageUrl?: string | null; imageExifTime: Date | null; note: string | null; kontrollCode: string | null };
  kontrollen: {
    entryId: string | null; time: Date; imageUrl: string | null; note: string | null;
    deadline: Date | null; kommentar: string | null; code: string | null;
    anforderungStatus: string | null; verifikationStatus: string | null; submittedAt: Date | null;
  }[];
  interruptions: { oeffnen: { id: string; startTime: Date; note: string | null }; verschluss: { startTime: Date; imageUrl: string | null; codeImageUrl?: string | null } }[];
};

type OrgasmusEntry = { id: string; startTime: Date; imageUrl: string | null; note: string | null; orgasmusArt: string | null };

/** Builds the sorted SessionEvent array for the active session timeline.
 *  `resolveOrgasmus` maps a stored orgasmusArt code (+ optional detail suffix) to its owner-config
 *  display label; omitted → the raw stored value is shown (built-in-compatible). */
export function buildSessionEvents(
  activePair: ActivePair,
  orgasmusEntries: OrgasmusEntry[],
  dl: string,
  resolveOrgasmus?: (art: string | null) => string | null,
): SessionEvent[] {
  return [
    {
      type: "verschluss" as const,
      time: activePair.verschluss.startTime,
      imageUrl: activePair.verschluss.imageUrl,
      codeImageUrl: activePair.verschluss.codeImageUrl ?? null,
      imageExifTime: activePair.verschluss.imageExifTime,
      note: activePair.verschluss.note,
      entryId: activePair.verschluss.id,
      kontrolleCode: activePair.verschluss.kontrollCode,
    },
    ...activePair.kontrollen
      .filter(k => k.entryId !== null)
      .map(k => ({
        type: "kontrolle" as const,
        time: k.time,
        imageUrl: k.imageUrl,
        imageExifTime: null,
        note: k.note,
        entryId: k.entryId,
        deadline: k.deadline,
        kontrolleKommentar: k.kommentar,
        kontrolleCode: k.code,
        kontrolleAnforderungStatus: k.anforderungStatus,
        kontrolleVerifikationStatus: k.verifikationStatus,
        submittedAt: k.submittedAt,
      })),
    ...orgasmusEntries
      .filter(e => e.startTime >= activePair.verschluss.startTime)
      .map(e => ({
        type: "orgasmus" as const,
        time: e.startTime,
        imageUrl: e.imageUrl,
        imageExifTime: null,
        note: e.note,
        entryId: e.id,
        orgasmusArt: resolveOrgasmus ? resolveOrgasmus(e.orgasmusArt) : e.orgasmusArt,
      })),
    ...activePair.interruptions.map(intr => ({
      type: "reinigung" as const,
      time: intr.oeffnen.startTime,
      imageUrl: intr.verschluss.imageUrl,
      codeImageUrl: intr.verschluss.codeImageUrl ?? null,
      imageExifTime: null,
      note: intr.oeffnen.note,
      entryId: intr.oeffnen.id,
      pauseDurationStr: formatDuration(intr.oeffnen.startTime, intr.verschluss.startTime, dl),
    })),
  ].sort((a, b) => a.time.getTime() - b.time.getTime());
}

type PlugPauseIn = { type: string; startTime: Date; imageUrl: string | null; note: string | null; oeffnenGrund: string | null };
type PlugKontrolleIn = {
  entryId: string | null; time: Date; imageUrl: string | null; note: string | null; deadline: Date | null;
  kommentar: string | null; code: string | null; anforderungStatus: string | null; verifikationStatus: string | null; submittedAt: Date | null;
};

/** Baut die SessionEvent-Liste für die aktive PLUG-Session: abgeschlossene Pausen (Reinigung/Toilette,
 *  als "reinigung"-Events mit korrektem Grund-Label) + PLUG-Kontrollen (gleiche Pills wie KG). */
export function buildPlugSessionEvents(
  sessionStart: Date,
  plugPauses: PlugPauseIn[],
  plugKontrollen: PlugKontrolleIn[],
  dl: string,
): SessionEvent[] {
  const events: SessionEvent[] = [];
  const sorted = plugPauses
    .filter((p) => p.startTime >= sessionStart)
    .slice()
    .sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
  let openBegin: PlugPauseIn | null = null;
  for (const p of sorted) {
    if (p.type === "PAUSE_BEGIN") openBegin = p;
    else if (p.type === "PAUSE_END" && openBegin) {
      events.push({
        type: "reinigung" as const,
        time: openBegin.startTime,
        imageUrl: p.imageUrl ?? openBegin.imageUrl,
        imageExifTime: null,
        note: openBegin.note ?? p.note,
        entryId: null,
        pauseDurationStr: formatDuration(p.startTime, openBegin.startTime, dl),
        reinigungGrund: openBegin.oeffnenGrund,
      });
      openBegin = null;
    }
  }
  for (const k of plugKontrollen.filter((k) => k.entryId !== null && k.time >= sessionStart)) {
    events.push({
      type: "kontrolle" as const,
      time: k.time,
      imageUrl: k.imageUrl,
      imageExifTime: null,
      note: k.note,
      entryId: k.entryId,
      deadline: k.deadline,
      kontrolleKommentar: k.kommentar,
      kontrolleCode: k.code,
      kontrolleAnforderungStatus: k.anforderungStatus,
      kontrolleVerifikationStatus: k.verifikationStatus,
      submittedAt: k.submittedAt,
    });
  }
  return events.sort((a, b) => a.time.getTime() - b.time.getTime());
}
