"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { X, Bot, Check, RotateCcw } from "lucide-react";
import Select from "@/app/components/Select";
import Button from "@/app/components/Button";
import Badge from "@/app/components/Badge";
import FormError from "@/app/components/FormError";

interface Person { id: string; username: string }
interface Candidate extends Person { role?: string }
interface AiPersona { id: string; name: string; systemPrompt: string }

/** One user row in the keyholder lists — username left, a trailing control right (remove button for
 *  assigned keyholders, an "Admin" badge for implicit ones). Shared shell so the layout stays in sync. */
function PersonRow({ username, trailing }: { username: string; trailing: ReactNode }) {
  return (
    <li className="flex items-center justify-between gap-2 bg-surface-raised rounded-lg px-3 py-2">
      <span className="text-sm text-foreground">{username}</span>
      {trailing}
    </li>
  );
}

/** Admin assigns/removes keyholders for a sub (AdminUserRelationship). Self-control is rejected. */
export default function KeyholderManager({ subId, initial, aiKeyholderActive = false, aiPersonas = [], currentPersonaName = null }: { subId: string; initial: Person[]; aiKeyholderActive?: boolean; aiPersonas?: AiPersona[]; currentPersonaName?: string | null }) {
  const t = useTranslations("admin");
  const tc = useTranslations("common");
  const router = useRouter();
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selected, setSelected] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [personaId, setPersonaId] = useState("");
  const [applyingPersona, setApplyingPersona] = useState(false);
  const [personaSuccess, setPersonaSuccess] = useState(false);
  // Track the currently active persona name — seed from server prop, update on apply
  const [activePersonaName, setActivePersonaName] = useState<string | null>(currentPersonaName ?? null);
  const [resetConfirm, setResetConfirm] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetSuccess, setResetSuccess] = useState(false);

  useEffect(() => {
    fetch("/api/admin/users")
      .then((r) => (r.ok ? r.json() : []))
      .then((u: Candidate[]) => setCandidates(u))
      .catch(() => {});
  }, []);

  const assignedIds = new Set(initial.map((k) => k.id));
  // Zuweisbar ist nur ein ANDERER Nicht-Admin-User, der nicht schon Keyholder ist:
  //  - der Sub selbst scheidet aus (niemand ist sein eigener Keyholder),
  //  - Admins scheiden aus, weil sie ohnehin ALLE Subs kontrollieren — ein Keyholder-Eintrag wäre
  //    redundant (die Route lehnt es zusätzlich serverseitig ab). Der „Keyholder dieses Subs"-
  //    Mechanismus ist genau für den Nicht-Admin-Fall: ein normaler User, der NUR diesen Sub
  //    kontrollieren soll (chirurgischer /admin-Zugang).
  // Folge: Gibt es ausser dem Sub nur Admins, ist die Liste leer und das Dropdown erscheint nicht —
  // dann greift der Hinweis unten (keyholdersNoCandidates).
  const options = candidates
    .filter((c) => c.id !== subId && c.role !== "admin" && !assignedIds.has(c.id))
    .map((c) => ({ value: c.id, label: c.username }));
  // Kandidaten sind geladen (>0), aber keiner ist zuweisbar → erklärender Hinweis statt leerem Nichts.
  const noAssignable = candidates.length > 0 && options.length === 0;
  // Admins kontrollieren diesen Sub ohnehin automatisch (Keyholder-über-alle). Sie werden hier rein zur
  // ANZEIGE gelistet (nicht entfernbar — Kontrolle kommt aus der Rolle, nicht aus einem Eintrag), damit
  // sichtbar ist, wer den Sub wirklich kontrolliert. Sub selbst ausgeschlossen (kein Selbst-Keyholder);
  // bereits explizit zugewiesene raus (ein zum Admin beförderter Ex-Keyholder mit noch bestehender
  // Relationship-Zeile soll nicht doppelt — hier UND in der entfernbaren Liste oben — erscheinen).
  const admins = candidates.filter(
    (c) => c.role === "admin" && c.id !== subId && !assignedIds.has(c.id),
  );

  async function applyPersona() {
    const persona = aiPersonas.find((p) => p.id === personaId);
    if (!persona) return;
    setApplyingPersona(true);
    setPersonaSuccess(false);
    try {
      const res = await fetch(`/api/admin/ai-keyholder/${subId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ systemPrompt: persona.systemPrompt, personaId: persona.id }),
      });
      if (res.ok) {
        setActivePersonaName(persona.name);
        setPersonaSuccess(true);
        setTimeout(() => setPersonaSuccess(false), 2500);
      }
    } finally {
      setApplyingPersona(false);
    }
  }

  async function handleReset() {
    setResetting(true);
    setResetConfirm(false);
    try {
      await fetch(`/api/admin/ai-keyholder/${subId}/messages`, { method: "DELETE" });
      setResetSuccess(true);
      setTimeout(() => setResetSuccess(false), 3000);
    } finally {
      setResetting(false);
    }
  }

  async function mutate(method: "POST" | "DELETE", keyholderId: string) {
    setSaving(true);
    setError("");
    try {
      const res = await fetch(`/api/admin/users/${subId}/keyholders`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keyholderId }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || tc("error"));
      }
      setSelected("");
      router.refresh();
    } catch (e) {
      setError((e as Error).message || tc("networkError"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {/* AI Keyholder row — shown when the AI keyholder is enabled for this sub */}
      {aiKeyholderActive && (
        <div className="flex flex-col gap-2">
          <ul className="flex flex-col gap-1.5">
            <li className="flex items-center justify-between gap-2 bg-surface-raised rounded-lg px-3 py-2">
              <span className="flex items-center gap-2 text-sm text-foreground min-w-0">
                <Bot size={15} className="text-accent shrink-0" />
                <span className="truncate">
                  {t("aiKeyholderLabel")}
                  {activePersonaName && (
                    <span className="text-foreground-muted"> · {activePersonaName}</span>
                  )}
                </span>
              </span>
              <Badge variant="ok" label={t("aiKeyholderBadge")} size="sm" />
            </li>
          </ul>
          {aiPersonas.length > 0 && (
            <div className="flex items-center gap-2 px-1">
              <select
                value={personaId}
                onChange={(e) => setPersonaId(e.target.value)}
                className="flex-1 text-xs bg-surface-subtle border border-border rounded-lg px-2.5 py-1.5 text-foreground focus:outline-none focus:ring-2 focus:ring-accent/40"
              >
                <option value="">{t("personaSelectPlaceholder")}</option>
                {aiPersonas.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              <button
                type="button"
                disabled={!personaId || applyingPersona}
                onClick={applyPersona}
                className="flex items-center gap-1 text-xs font-medium text-accent border border-accent/30 hover:border-accent/60 rounded-lg px-2.5 py-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
              >
                <Check size={12} />
                {personaSuccess ? t("personaApplied") : t("personaApply")}
              </button>
            </div>
          )}
          {/* Reset conversation + memory */}
          <div className="flex items-center gap-2 px-1">
            {resetConfirm ? (
              <>
                <span className="text-xs text-warn flex-1">{t("aikhResetConfirm")}</span>
                <button
                  type="button"
                  onClick={handleReset}
                  disabled={resetting}
                  className="text-xs font-medium text-warn border border-warn/40 hover:border-warn rounded-lg px-2.5 py-1.5 transition-colors disabled:opacity-40 whitespace-nowrap"
                >
                  {t("aikhResetConfirmYes")}
                </button>
                <button
                  type="button"
                  onClick={() => setResetConfirm(false)}
                  className="text-xs text-foreground-muted hover:text-foreground transition-colors"
                >
                  {tc("cancel")}
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setResetConfirm(true)}
                disabled={resetting}
                className="flex items-center gap-1 text-xs text-foreground-muted hover:text-warn border border-border hover:border-warn/40 rounded-lg px-2.5 py-1.5 transition-colors disabled:opacity-40"
              >
                <RotateCcw size={12} />
                {resetSuccess ? t("aikhResetDone") : t("aikhResetMemory")}
              </button>
            )}
          </div>
        </div>
      )}
      {initial.length === 0 && !aiKeyholderActive ? (
        <p className="text-sm text-foreground-muted">{t("keyholdersNone")}</p>
      ) : initial.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {initial.map((k) => (
            <PersonRow
              key={k.id}
              username={k.username}
              trailing={
                <button
                  onClick={() => mutate("DELETE", k.id)}
                  disabled={saving}
                  title={tc("delete")}
                  className="p-1 text-warn hover:bg-warn-bg rounded-full disabled:opacity-50 transition"
                >
                  <X size={16} />
                </button>
              }
            />
          ))}
        </ul>
      ) : null}
      {admins.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs text-foreground-faint">{t("keyholdersAdminsNote")}</p>
          <ul className="flex flex-col gap-1.5">
            {admins.map((a) => (
              <PersonRow
                key={a.id}
                username={a.username}
                trailing={<Badge variant="neutral" label={t("roleAdmin")} size="sm" />}
              />
            ))}
          </ul>
        </div>
      )}
      {options.length > 0 && (
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <Select
              options={[{ value: "", label: t("keyholderSelect") }, ...options]}
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
            />
          </div>
          <Button onClick={() => mutate("POST", selected)} loading={saving} disabled={!selected}>
            {t("keyholderAdd")}
          </Button>
        </div>
      )}
      {noAssignable && (
        <p className="text-xs text-foreground-faint">{t("keyholdersNoCandidates")}</p>
      )}
      <FormError message={error} variant="compact" />
    </div>
  );
}
