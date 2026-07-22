"use client";

import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import { Pencil, Trash2, ChevronDown, ChevronUp, Plus, Check } from "lucide-react";
import Button from "@/app/components/Button";
import Input from "@/app/components/Input";
import Textarea from "@/app/components/Textarea";
import FormError from "@/app/components/FormError";

interface Persona {
  id: string;
  name: string;
  description: string | null;
  systemPrompt: string;
  appearance: string | null;
  seed: number | null;
  avatarPath: string | null;
}

interface Props {
  /** Called when "Übernehmen" is clicked — applies the persona (prompt + look + seed + avatar). */
  onApply: (p: Persona) => void;
  /** The current system prompt in the parent (used to pre-fill "save as persona" form). */
  currentPrompt: string;
  /** The user whose media backend generates persona avatars. */
  userId: string;
}

export default function PersonaManager({ onApply, currentPrompt, userId }: Props) {
  const t = useTranslations("admin");

  const [personas, setPersonas] = useState<Persona[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [selectedId, setSelectedId] = useState<string>("");

  // Create form
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createDesc, setCreateDesc] = useState("");
  const [createPrompt, setCreatePrompt] = useState("");
  const [createAppearance, setCreateAppearance] = useState("");
  const [createSeed, setCreateSeed] = useState("");
  const [creating, setCreating] = useState(false);

  // Edit form
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editPrompt, setEditPrompt] = useState("");
  const [editAppearance, setEditAppearance] = useState("");
  const [editSeed, setEditSeed] = useState("");
  const [saving, setSaving] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [genAvatarId, setGenAvatarId] = useState<string | null>(null);
  const [avatarMsg, setAvatarMsg] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/admin/ai-personas")
      .then((r) => r.json())
      .then((data) => { setPersonas(Array.isArray(data) ? data : []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  function openCreate() {
    setCreateName("");
    setCreateDesc("");
    setCreatePrompt(currentPrompt);
    setCreateAppearance("");
    setCreateSeed("");
    setError(null);
    setShowCreate(true);
    setExpanded(true);
  }

  function openEdit(p: Persona) {
    setEditingId(p.id);
    setEditName(p.name);
    setEditDesc(p.description ?? "");
    setEditPrompt(p.systemPrompt);
    setEditAppearance(p.appearance ?? "");
    setEditSeed(p.seed != null ? String(p.seed) : "");
    setError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setError(null);
  }

  async function handleCreate() {
    setError(null);
    if (!createName.trim() || !createPrompt.trim()) return;
    setCreating(true);
    try {
      const res = await fetch("/api/admin/ai-personas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: createName, description: createDesc, systemPrompt: createPrompt, appearance: createAppearance, seed: createSeed.trim() !== "" ? Number(createSeed) : null }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error === "nameExists" ? t("personaNameExists") : (data.error ?? t("personaSaveFailed")));
        return;
      }
      setPersonas((prev) => [...prev, data].sort((a, b) => a.name.localeCompare(b.name)));
      setShowCreate(false);
    } catch {
      setError(t("personaSaveFailed"));
    } finally {
      setCreating(false);
    }
  }

  async function handleSaveEdit() {
    if (!editingId || !editName.trim() || !editPrompt.trim()) return;
    setError(null);
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/ai-personas/${editingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: editName, description: editDesc, systemPrompt: editPrompt, appearance: editAppearance, seed: editSeed.trim() !== "" ? Number(editSeed) : null }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error === "nameExists" ? t("personaNameExists") : (data.error ?? t("personaSaveFailed")));
        return;
      }
      setPersonas((prev) =>
        prev.map((p) => (p.id === editingId ? data : p)).sort((a, b) => a.name.localeCompare(b.name)),
      );
      setEditingId(null);
    } catch {
      setError(t("personaSaveFailed"));
    } finally {
      setSaving(false);
    }
  }

  async function handleGenerateAvatar(personaId: string) {
    setError(null);
    setAvatarMsg(null);
    setGenAvatarId(personaId);
    try {
      const res = await fetch("/api/ai-keyholder/generate-avatar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, personaId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Fehler" }));
        throw new Error(data.error ?? t("personaSaveFailed"));
      }
      setAvatarMsg(t("aikhAvatarQueued"));
    } catch (e) {
      setError(String(e));
    } finally {
      setGenAvatarId(null);
    }
  }

  async function handleDelete(id: string) {
    setDeletingId(id);
    try {
      await fetch(`/api/admin/ai-personas/${id}`, { method: "DELETE" });
      setPersonas((prev) => prev.filter((p) => p.id !== id));
      if (editingId === id) setEditingId(null);
    } finally {
      setDeletingId(null);
    }
  }

  if (loading) return null;

  const selectedPersona = personas.find((p) => p.id === selectedId) ?? null;

  return (
    <div className="flex flex-col gap-3">
      {/* Quick-apply row — always visible */}
      <div className="flex items-center gap-2">
        <select
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
          className="flex-1 text-sm bg-surface-subtle border border-border rounded-xl px-3 py-1.5 text-foreground focus:outline-none focus:ring-2 focus:ring-accent/40"
        >
          <option value="">{t("personaSelectPlaceholder")}</option>
          {personas.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <button
          type="button"
          disabled={!selectedPersona}
          onClick={() => selectedPersona && onApply(selectedPersona)}
          className="flex items-center gap-1 text-sm font-medium text-accent border border-accent/30 hover:border-accent/60 rounded-xl px-3 py-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Check size={13} />
          {t("personaApply")}
        </button>
      </div>

      {/* Collapsible management section */}
      <div className="flex items-center justify-between">
        <button
          type="button"
          className="flex items-center gap-1.5 text-xs font-semibold text-foreground-muted hover:text-foreground transition-colors"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          {t("personaManage")} ({personas.length})
        </button>
        <button
          type="button"
          onClick={openCreate}
          className="flex items-center gap-1 text-xs text-accent hover:underline underline-offset-2 transition-colors"
        >
          <Plus size={12} />
          {t("personaSaveAsCurrent")}
        </button>
      </div>

      {expanded && (
        <div className="flex flex-col gap-2">
          {error && <FormError message={error} />}

          {/* Create form */}
          {showCreate && (
            <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface-subtle px-4 py-3">
              <p className="text-xs font-semibold text-foreground">{t("personaNew")}</p>
              <Input
                label={t("personaName")}
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder={t("personaNamePlaceholder")}
              />
              <Input
                label={t("personaDescription")}
                value={createDesc}
                onChange={(e) => setCreateDesc(e.target.value)}
                placeholder={t("personaDescPlaceholder")}
              />
              <Textarea
                label={t("aikhSystemPrompt")}
                value={createPrompt}
                onChange={(e) => setCreatePrompt(e.target.value)}
                rows={5}
              />
              <Textarea
                label={t("personaAppearance")}
                value={createAppearance}
                onChange={(e) => setCreateAppearance(e.target.value)}
                placeholder={t("personaAppearancePlaceholder")}
                rows={3}
              />
              <Input
                label={t("aikhMediaSeed")}
                hint={t("aikhMediaSeedHint")}
                type="number"
                placeholder="z. B. 12345"
                value={createSeed}
                onChange={(e) => setCreateSeed(e.target.value)}
              />
              <div className="flex gap-2 justify-end">
                <Button variant="ghost" size="sm" onClick={() => setShowCreate(false)}>{t("cancel")}</Button>
                <Button size="sm" loading={creating} onClick={handleCreate}>{t("personaCreate")}</Button>
              </div>
            </div>
          )}

          {/* Persona list */}
          {personas.length === 0 && !showCreate && (
            <p className="text-xs text-foreground-muted">{t("personaNone")}</p>
          )}

          {personas.map((p) =>
            editingId === p.id ? (
              /* Edit mode */
              <div key={p.id} className="flex flex-col gap-2 rounded-xl border border-accent/30 bg-surface-subtle px-4 py-3">
                <Input
                  label={t("personaName")}
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                />
                <Input
                  label={t("personaDescription")}
                  value={editDesc}
                  onChange={(e) => setEditDesc(e.target.value)}
                />
                <Textarea
                  label={t("aikhSystemPrompt")}
                  value={editPrompt}
                  onChange={(e) => setEditPrompt(e.target.value)}
                  rows={5}
                />
                <Textarea
                  label={t("personaAppearance")}
                  value={editAppearance}
                  onChange={(e) => setEditAppearance(e.target.value)}
                  placeholder={t("personaAppearancePlaceholder")}
                  rows={3}
                />
                <Input
                  label={t("aikhMediaSeed")}
                  hint={t("aikhMediaSeedHint")}
                  type="number"
                  placeholder="z. B. 12345"
                  value={editSeed}
                  onChange={(e) => setEditSeed(e.target.value)}
                />
                <div className="flex flex-col gap-2 border-t border-border pt-2">
                  <p className="text-xs font-semibold text-foreground">{t("aikhAvatar")}</p>
                  {p.avatarPath ? (
                    <img src={`/api/uploads/${p.avatarPath}`} alt="Avatar" className="h-24 w-24 rounded-full border border-border object-cover" />
                  ) : (
                    <p className="text-xs text-foreground-muted">{t("aikhAvatarNone")}</p>
                  )}
                  <button
                    type="button"
                    onClick={() => handleGenerateAvatar(p.id)}
                    disabled={genAvatarId === p.id}
                    className="self-start inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-surface disabled:opacity-50"
                  >
                    {genAvatarId === p.id ? t("aikhAvatarGenerating") : t("aikhAvatarGenerate")}
                  </button>
                  {avatarMsg && <p className="text-xs text-foreground-muted">{avatarMsg}</p>}
                </div>
                <div className="flex gap-2 justify-end">
                  <Button variant="ghost" size="sm" onClick={cancelEdit}>{t("cancel")}</Button>
                  <Button size="sm" loading={saving} onClick={handleSaveEdit}>{t("save")}</Button>
                </div>
              </div>
            ) : (
              /* Display mode */
              <div
                key={p.id}
                className="flex items-start justify-between gap-2 rounded-xl border border-border bg-surface-raised px-3 py-2.5"
              >
                <div className="flex flex-col gap-0.5 min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">{p.name}</p>
                  {p.description && (
                    <p className="text-xs text-foreground-muted truncate">{p.description}</p>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    title={t("personaApply")}
                    onClick={() => onApply(p)}
                    className="flex items-center gap-1 text-xs text-accent hover:text-accent/80 border border-accent/30 hover:border-accent/60 rounded-lg px-2 py-1 transition-colors"
                  >
                    <Check size={12} />
                    {t("personaApply")}
                  </button>
                  <button
                    type="button"
                    title={t("edit")}
                    onClick={() => openEdit(p)}
                    className="p-1.5 rounded-lg text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors"
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    type="button"
                    title={t("delete")}
                    disabled={deletingId === p.id}
                    onClick={() => handleDelete(p.id)}
                    className="p-1.5 rounded-lg text-foreground-muted hover:text-warn transition-colors disabled:opacity-40"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}
