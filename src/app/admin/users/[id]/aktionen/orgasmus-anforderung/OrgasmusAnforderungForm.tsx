"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Droplets } from "lucide-react";
import { useTranslations } from "next-intl";
import { fromDatetimeLocal } from "@/lib/utils";
import {
  ORGASMUS_ANFORDERUNG_ARTEN, orgasmusAnforderungArtLabel,
  DURATION_QUICK_HOURS, durationHoursOr, type DurationUnit,
} from "@/lib/constants";
import AdminActionFormShell from "@/app/components/AdminActionFormShell";
import { actionSign } from "@/app/entries/actionSign";
import DateTimePicker from "@/app/components/DateTimePicker";
import DurationOrDatetimeField from "@/app/components/DurationOrDatetimeField";
import FormError from "@/app/components/FormError";
import ScheduleFields, {
  initialSchedule, scheduleAnchorMs, scheduleIsPast, schedulePayload, type ScheduleValue,
} from "@/app/components/ScheduleFields";
import Select from "@/app/components/Select";
import Textarea from "@/app/components/Textarea";
import Checkbox from "@/app/components/Checkbox";
import Button from "@/app/components/Button";
import TimePreview from "@/app/components/TimePreview";
import { parseApiErrorCode } from "@/lib/apiClient";
import { useApiError } from "@/app/hooks/useApiError";

/** Wie das Fenster-ENDE angegeben wird — dieselben zwei Antwort-Arten wie an der Verschluss-Frist.
 *  „Dauer" ist die Vorgabe, weil ein Fenster in Stunden gedacht wird („24 Stunden Zeit"), nicht als
 *  Uhrzeit — und weil nur dieser Weg richtig bleibt, wenn das Formular eine Weile offen liegt. */
type EndMode = "duration" | "datetime";

/** Vorgabe-Fenster: ein Tag. */
const DEFAULT_WINDOW_H = 24;

/** Fork: Kuratierte Art-Presets für „Orgasmus anfordern". Jedes Preset codiert Orgasmus-Art + ob
 *  geöffnet werden darf — dadurch entfällt eine separate „Öffnen erlaubt"-Checkbox (und die freie
 *  Art-Liste des Subs). */
type ArtPreset = "orgasmus" | "ruiniert_verschlossen" | "ruiniert_offen";
const ART_PRESETS: Record<ArtPreset, { requiredType: string; openingAllowed: boolean }> = {
  orgasmus: { requiredType: "Orgasmus", openingAllowed: true },
  ruiniert_verschlossen: { requiredType: "ruinierter Orgasmus", openingAllowed: false },
  ruiniert_offen: { requiredType: "ruinierter Orgasmus", openingAllowed: true },
};

export default function OrgasmusAnforderungForm({ userId, tz, nowDefault }: { userId: string; tz: string; nowDefault: string }) {
  const t = useTranslations("admin");
  const tc = useTranslations("common");
  const apiError = useApiError();
  const router = useRouter();
  const target = `/admin/users/${userId}/aktionen`;

  const [art, setArt] = useState<(typeof ORGASMUS_ANFORDERUNG_ARTEN)[number]>("ANWEISUNG");
  const [beginsAt, setBeginsAt] = useState(nowDefault);
  const [endMode, setEndMode] = useState<EndMode>("duration");
  const [windowH, setWindowH] = useState(String(DEFAULT_WINDOW_H));
  const [windowUnit, setWindowUnit] = useState<DurationUnit>("h");
  // Leer, nicht vorbelegt: gefüllt wird erst, wenn jemand den Zeitpunkt-Reiter wählt (siehe
  // `switchEndMode`). Ein beim Seitenaufruf gerechnetes Ende wäre nach zehn Minuten
  // Formularausfüllen zehn Minuten zu früh.
  const [endsAt, setEndsAt] = useState("");
  const [artPreset, setArtPreset] = useState<ArtPreset>("orgasmus");
  // Fork: Belohnung (bucht 1 vom verdienten Guthaben ab), Straf-Anweisung, Foto-Pflicht.
  const [belohnung, setBelohnung] = useState(false);
  const [istStrafe, setIstStrafe] = useState(false);
  const [fotoPflicht, setFotoPflicht] = useState(false);
  const [message, setMessage] = useState("");
  // Terminierung — dasselbe Bauteil und dieselben zwei Felder wie an Aufgabe und
  // Verschluss-Anforderung. Bis zur Auslösung ist die Anweisung für den Träger unsichtbar: sie
  // steht nicht im Dashboard, erlaubt kein Öffnen und erfüllt sich nicht.
  const [schedule, setSchedule] = useState<ScheduleValue>(() => initialSchedule(nowDefault, tz));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const modeOptions = ORGASMUS_ANFORDERUNG_ARTEN.map((a) => ({
    value: a,
    label: orgasmusAnforderungArtLabel(a, t),
  }));
  const presetOptions: { value: ArtPreset; label: string }[] = [
    { value: "orgasmus", label: t("orgasmReqPresetOrgasmus") },
    { value: "ruiniert_verschlossen", label: t("orgasmReqPresetRuiniertClosed") },
    { value: "ruiniert_offen", label: t("orgasmReqPresetRuiniertOpen") },
  ];

  /**
   * Das Fenster-Ende aus dem gerade gewählten Reiter — EINE Rechnung für Vorschau und Absenden.
   *
   * Die Dauer zählt ab dem Fenster-START, nicht ab dem Auslösen: „24 Stunden Zeit" ist eine Aussage
   * über das Fenster, und der Start steht als eigenes Feld darüber. Ein leerer Start ergibt ein
   * ungültiges Datum — die Vorschau zeigt dann nichts, statt eine Zeit zu nennen, die niemand
   * gewählt hat. Das Dauer-Feld selbst ist `required`; ohne das fiele ein geleertes Feld still auf
   * die Vorgabe zurück und legte ein 24-Stunden-Fenster an, das niemand gewählt hat.
   */
  function endAt(): Date {
    if (endMode === "datetime") return fromDatetimeLocal(endsAt, tz);
    const start = fromDatetimeLocal(beginsAt, tz);
    return new Date(start.getTime() + durationHoursOr(windowH, windowUnit, DEFAULT_WINDOW_H) * 3600_000);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const beginsAtDate = fromDatetimeLocal(beginsAt, tz);
    const endet = endAt();
    // In der Zone des SUBS gerechnet, wie jede andere Zeit dieses Formulars. `new Date("…")` las die
    // beiden Felder in der Zone des Browsers — bei einer Keyholderin in einer anderen Zone als ihrem
    // Sub verglich das zwei verschobene Zeitpunkte.
    if (Number.isNaN(beginsAtDate.getTime()) || Number.isNaN(endet.getTime()) || endet <= beginsAtDate) {
      setError(t("orgasmReqEndAfterStart"));
      return;
    }
    if (!belohnung && scheduleIsPast(schedule, tz)) {
      setError(t("scheduleFutureRequired"));
      return;
    }
    // Das Fenster muss den VERSAND überleben, nicht bloss „jetzt": bei „Dauer 24 h" und „Versand in
    // 48 h" liegt das Ende zwar in der Zukunft, aber vor der Zustellung — der Server lehnt das ab,
    // und seine Meldung („Das Ende des Fensters muss in der Zukunft liegen") beschreibt genau das
    // Gegenteil dessen, was der Keyholder sieht. Deshalb hier, wo beide Zahlen stehen.
    if (!belohnung && endet <= new Date(scheduleAnchorMs(schedule, tz, Date.now()))) {
      setError(t("orgasmReqEndAfterSend"));
      return;
    }
    setSaving(true);
    setError("");
    try {
      // Belohnung: kein Modus/keine Art/keine Terminierung — das Fenster gewährt der Belohnungs-Dienst
      // (Öffnen immer erlaubt, sonst wäre der Orgasmus nicht durchführbar).
      const body: Record<string, unknown> = belohnung
        ? {
            userId,
            belohnung: true,
            beginsAt: beginsAtDate.toISOString(),
            endsAt: endet.toISOString(),
            message: message.trim() || undefined,
            fotoPflicht,
          }
        : {
            userId,
            art,
            beginsAt: beginsAtDate.toISOString(),
            endsAt: endet.toISOString(),
            requiredType: ART_PRESETS[artPreset].requiredType,
            openingAllowed: ART_PRESETS[artPreset].openingAllowed,
            istStrafe: art === "ANWEISUNG" ? istStrafe : false,
            fotoPflicht,
            message: message.trim() || undefined,
            ...schedulePayload(schedule, tz),
          };
      const res = await fetch("/api/admin/orgasmus-anforderung", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) router.push(target);
      else setError(apiError(await parseApiErrorCode(res)));
    } catch {
      setError(tc("networkError"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <AdminActionFormShell
      userId={userId}
      backLabel={t("aktionen")}
      {...actionSign("ORGASMUS")}
      title={t("requestOrgasm")}
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        {!belohnung && (
          <Select
            label={t("orgasmReqMode")}
            options={modeOptions}
            value={art}
            onChange={(e) => setArt(e.target.value as (typeof ORGASMUS_ANFORDERUNG_ARTEN)[number])}
          />
        )}
        {/* `min`: ein Fenster in der Vergangenheit ist der Fehler, den dieses Formular hatte. Der
            Dienst erlaubt einen rückdatierten START weiterhin (ein rückwirkend geöffnetes Fenster
            ist ein legitimer Fall, siehe `checkOrgasmWindowEnd`) — über den MCP bleibt er erreichbar,
            im Formular bewusst nicht. */}
        <DateTimePicker
          label={t("orgasmReqStart")}
          value={beginsAt}
          onChange={(e) => setBeginsAt(e.target.value)}
          min={nowDefault}
        />

        {/* Fenster-Ende: erst die Antwort-Art, dann ihr Feld — dasselbe Bauteil wie an der
            Verschluss-Frist. Die aufgelöste Uhrzeit darunter ist die einzige Angabe, die in beiden
            Reitern dasselbe bedeutet. */}
        <DurationOrDatetimeField
          label={t("orgasmReqEnd")}
          mode={endMode}
          onModeChange={setEndMode}
          value={windowH}
          unit={windowUnit}
          onDurationChange={(value, unit) => { setWindowH(value); setWindowUnit(unit); }}
          quick={DURATION_QUICK_HOURS.long}
          datetime={endsAt}
          onDatetimeChange={setEndsAt}
          datetimeMin={beginsAt}
          // Der Nullpunkt der Dauer ist der Fenster-START, nicht „jetzt" — er steht als eigenes Feld
          // darüber, und „24 Stunden Zeit" ist eine Aussage über das Fenster.
          anchorMs={() => fromDatetimeLocal(beginsAt, tz).getTime()}
          tz={tz}
          required
        >
          {/* Ohne `nowMs`: das Fenster-Ende zählt ab dem eingegebenen START, nicht ab „jetzt" — es
              steht still, solange niemand tippt. */}
          <TimePreview
            at={endAt}
            tz={tz}
            line={(formatted) => ({ text: t("orgasmReqEndPreview", { time: formatted }) })}
          />
        </DurationOrDatetimeField>

        {!belohnung && (
          <Select
            label={t("orgasmReqArt")}
            options={presetOptions}
            value={artPreset}
            onChange={(e) => setArtPreset(e.target.value as ArtPreset)}
          />
        )}

        {/* Belohnung — wie „Belohnung gewähren": bucht 1 vom verdienten Guthaben ab. */}
        <Checkbox
          label={t("orgasmReqBelohnungLabel")}
          description={t("orgasmReqBelohnungHint")}
          checked={belohnung}
          onChange={(e) => setBelohnung(e.target.checked)}
        />
        {!belohnung && art === "ANWEISUNG" && (
          <Checkbox
            label={t("orgasmReqIstStrafeLabel")}
            description={t("orgasmReqIstStrafeHint")}
            checked={istStrafe}
            onChange={(e) => setIstStrafe(e.target.checked)}
          />
        )}
        {/* Foto-Nachweis: Pflicht beim Erfassen. Ohne Haken ist ein Foto freiwillig möglich. */}
        <Checkbox
          label={t("orgasmReqFotoPflichtLabel")}
          description={t("orgasmReqFotoPflichtHint")}
          checked={fotoPflicht}
          onChange={(e) => setFotoPflicht(e.target.checked)}
        />
        <Textarea
          label={t("orgasmReqMessage")}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={2}
        />

        {/* Terminierung nicht bei der Belohnung: der Belohnungs-Dienst gewährt sofort. */}
        {!belohnung && (
          <ScheduleFields
            value={schedule}
            onChange={setSchedule}
            minNow={nowDefault}
            delayHint={t("orgasmScheduleDelayHint")}
            atHint={t("orgasmScheduleAtHint")}
          />
        )}

        <FormError message={error} variant="compact" />

        <Button type="submit" variant="semantic" semantic="orgasm" fullWidth loading={saving} icon={<Droplets size={16} />}>
          {saving ? t("sending") : t("orgasmReqSubmit")}
        </Button>
      </form>
    </AdminActionFormShell>
  );
}
