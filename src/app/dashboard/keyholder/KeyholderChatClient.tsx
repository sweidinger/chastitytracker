"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Send, Lock, CheckCircle, Clock, AlertTriangle, ShieldAlert, KeyRound, Timer, MessageCircle, Target, Zap, PlayCircle, ArrowRight } from "lucide-react";

/** Actionable AI-Anweisungen → Start-/Erfüllungs-Seite im Tracker (CTA-Button unter der Status-Pill).
 *  Nur Aktionen, die der Sub aktiv erfüllt; reine Keyholder-Aktionen (Sperrzeit/Strafe/Vorgabe) haben keinen Button. */
type CtaKey = "ctaWearBegin" | "ctaSessionBegin" | "ctaOrgasmus" | "ctaVerschluss" | "ctaKontrolle";
const ACTION_START_ROUTES: Record<string, { href: string; key: CtaKey }> = {
  create_wear_anforderung: { href: "/dashboard/new/wear-begin", key: "ctaWearBegin" },
  create_session_anforderung: { href: "/dashboard/new/session-begin", key: "ctaSessionBegin" },
  create_orgasmus: { href: "/dashboard/new/orgasmus", key: "ctaOrgasmus" },
  create_anforderung: { href: "/dashboard/new/verschluss", key: "ctaVerschluss" },
  create_kontrolle: { href: "/dashboard", key: "ctaKontrolle" },
};
import Card from "@/app/components/Card";
import Button from "@/app/components/Button";
import Spinner from "@/app/components/Spinner";
import EmptyState from "@/app/components/EmptyState";

// ── Types ────────────────────────────────────────────────────────────────────


function uid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
}

interface ActionPill {
  ok: boolean;
  actionType: string;
  label: string;
  error?: string;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  mediaId?: string;
  createdAt: string;
  streaming?: boolean;
  actionPills?: ActionPill[];
}

interface KeyholderTask {
  id: string;
  type: string;
  message: string;
  assignedAt: string;
  dueAt: string | null;
  media: { id: string; mediaType: string; filePath: string | null } | null;
}

interface Props {
  enabled: boolean;
  initialMessages: ChatMessage[];
  initialTasks: KeyholderTask[];
}

// ── Simple Markdown renderer ──────────────────────────────────────────────────
// Handles: **bold**, *italic*, - bullet lists, newlines → <br>

function renderMarkdown(text: string): React.ReactNode[] {
  const lines = text.split("\n");
  const result: React.ReactNode[] = [];

  lines.forEach((line, li) => {
    const isBullet = /^[\-\*]\s/.test(line);
    const raw = isBullet ? line.replace(/^[\-\*]\s/, "") : line;

    // Inline: **bold** and *italic*
    const parts = raw.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g);
    const inline: React.ReactNode[] = parts.map((part, pi) => {
      if (/^\*\*[^*]+\*\*$/.test(part)) {
        return <strong key={pi}>{part.slice(2, -2)}</strong>;
      }
      if (/^\*[^*]+\*$/.test(part)) {
        return <em key={pi}>{part.slice(1, -1)}</em>;
      }
      return part;
    });

    if (isBullet) {
      result.push(
        <span key={li} className="flex items-start gap-1.5 mt-0.5">
          <span className="mt-1 shrink-0 w-1.5 h-1.5 rounded-full bg-current opacity-60" />
          <span>{inline}</span>
        </span>,
      );
    } else {
      result.push(<span key={li}>{inline}</span>);
      if (li < lines.length - 1) result.push(<br key={`br-${li}`} />);
    }
  });

  return result;
}

// ── Event bubble (Kontrolle / Strafe / system) ────────────────────────────────

const EVENT_PATTERNS = [
  {
    prefix: "[Kontrolle]",
    icon: ShieldAlert,
    color: "bg-[var(--color-inspect-bg)] border-[var(--color-inspect-border)] text-[var(--color-inspect-text)]",
    labelKey: "eventKontrolle" as const,
  },
  {
    prefix: "[Strafe]",
    icon: AlertTriangle,
    color: "bg-[var(--color-warn-bg)] border-[var(--color-warn-border)] text-[var(--color-warn-text)]",
    labelKey: "eventStrafe" as const,
  },
  {
    prefix: "[Anforderung]",
    icon: KeyRound,
    color: "bg-[var(--color-request-bg)] border-[var(--color-request-border)] text-[var(--color-request-text)]",
    labelKey: "eventAnforderung" as const,
  },
  {
    prefix: "[Sperrzeit]",
    icon: Timer,
    color: "bg-[var(--color-sperrzeit-bg)] border-[var(--color-sperrzeit-border)] text-[var(--color-sperrzeit-text)]",
    labelKey: "eventSperrzeit" as const,
  },
  {
    prefix: "[Vorgabe]",
    icon: Target,
    color: "bg-[var(--color-unlock-bg)] border-[var(--color-unlock-border)] text-[var(--color-unlock-text)]",
    labelKey: "eventVorgabe" as const,
  },
  {
    prefix: "[Wear-Anforderung]",
    icon: Zap,
    color: "bg-[var(--color-warn-bg)] border-[var(--color-warn-border)] text-[var(--color-warn-text)]",
    labelKey: "eventWearAnforderung" as const,
  },
  {
    prefix: "[Session-Anforderung]",
    icon: PlayCircle,
    color: "bg-[var(--color-unlock-bg)] border-[var(--color-unlock-border)] text-[var(--color-unlock-text)]",
    labelKey: "eventSessionAnforderung" as const,
  },
];

function SystemEventBubble({ message, t }: { message: ChatMessage; t: ReturnType<typeof useTranslations<"keyholderChat">> }) {
  const match = EVENT_PATTERNS.find((p) => message.content.includes(p.prefix));
  if (!match) return null;

  const Icon = match.icon;
  const body = message.content
    .replace(/\[(Kontrolle|Strafe|Anforderung|Sperrzeit|Vorgabe|Wear-Anforderung|Session-Anforderung)\]/g, "")
    .replace(/^\[Autonome Prüfung\]\s*/i, "")
    .trim();

  return (
    <div className="flex justify-center my-3">
      <div
        className={`flex items-start gap-2.5 max-w-[90%] rounded-2xl border px-4 py-3 text-sm ${match.color}`}
      >
        <Icon className="w-4 h-4 shrink-0 mt-0.5" />
        <div>
          <p className="font-semibold text-xs uppercase tracking-wide mb-0.5">
            {t(match.labelKey)}
          </p>
          <p className="leading-relaxed">{body}</p>
          <p className="text-[10px] mt-1 opacity-60">
            {new Date(message.createdAt).toLocaleTimeString("de-CH", {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Chat bubble ───────────────────────────────────────────────────────────────

function ActionPillBubble({ pill, t }: { pill: ActionPill; t: ReturnType<typeof useTranslations<"keyholderChat">> }) {
  const color = pill.ok
    ? "bg-[var(--color-ok-bg)] border-[var(--color-ok-border)] text-[var(--color-ok-text)]"
    : "bg-[var(--color-warn-bg)] border-[var(--color-warn-border)] text-[var(--color-warn-text)]";
  const Icon = pill.ok ? CheckCircle : AlertTriangle;
  const route = pill.ok ? ACTION_START_ROUTES[pill.actionType] : undefined;
  return (
    <div className="inline-flex items-center gap-1.5 flex-wrap">
      <div className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${color}`}>
        <Icon size={11} />
        {pill.label}
        {!pill.ok && pill.error && <span className="opacity-70">· {pill.error}</span>}
      </div>
      {route && (
        <Link href={route.href}
          className="inline-flex items-center gap-1 rounded-full border border-[var(--color-ok)] bg-[var(--color-ok-bg)] px-2.5 py-1 text-xs font-semibold text-[var(--color-ok-text)] hover:opacity-80 transition">
          <PlayCircle size={12} />
          {t(route.key)}
          <ArrowRight size={11} />
        </Link>
      )}
    </div>
  );
}

function ChatBubble({ message, t }: { message: ChatMessage; t: ReturnType<typeof useTranslations<"keyholderChat">> }) {
  // System messages with event prefix → render as event card
  if (message.role === "system") {
    const hasEvent = EVENT_PATTERNS.some((p) => message.content.includes(p.prefix));
    if (hasEvent) return <SystemEventBubble message={message} t={t} />;
    return null; // plain system messages not shown
  }

  const isUser = message.role === "user";
  return (
    <div className={`flex flex-col ${isUser ? "items-end" : "items-start"} mb-3`}>
      <div
        className={[
          "max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed",
          isUser
            ? "bg-btn-primary text-btn-primary-text rounded-br-sm"
            : "bg-surface border border-border text-foreground rounded-bl-sm",
        ].join(" ")}
      >
        {message.streaming ? (
          <span>
            {renderMarkdown(message.content)}
            <span className="inline-block w-1.5 h-3.5 bg-current ml-0.5 animate-pulse rounded-sm align-middle" />
          </span>
        ) : isUser ? (
          message.content
        ) : (
          <span>{renderMarkdown(message.content)}</span>
        )}
        <div
          className={`text-[10px] mt-1 ${isUser ? "text-btn-primary-text/60" : "text-foreground-muted"}`}
        >
          {new Date(message.createdAt).toLocaleTimeString("de-CH", {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </div>
      </div>
      {/* Action pills — shown below assistant bubbles when AI triggered an action */}
      {!isUser && message.actionPills && message.actionPills.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-1.5 max-w-[80%]">
          {message.actionPills.map((pill, i) => (
            <ActionPillBubble key={i} pill={pill} t={t} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Task Banner ───────────────────────────────────────────────────────────────

function TaskBanner({
  task,
  t,
  onComplete,
}: {
  task: KeyholderTask;
  t: ReturnType<typeof useTranslations<"keyholderChat">>;
  onComplete: (taskId: string, response: string) => Promise<void>;
}) {
  const [response, setResponse] = useState("");
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const isOverdue = task.dueAt ? new Date(task.dueAt) < new Date() : false;

  async function handleSubmit() {
    if (!response.trim()) return;
    setSaving(true);
    try {
      await onComplete(task.id, response.trim());
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card variant="semantic" semantic={isOverdue ? "warn" : "request"} className="mb-3">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 shrink-0">
          {task.type === "WEAR_DEVICE" ? (
            <Zap size={18} className="text-foreground-muted" />
          ) : task.media ? (
            <Lock size={18} className="text-foreground-muted" />
          ) : (
            <CheckCircle size={18} className="text-foreground-muted" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground">
            {task.type === "WEAR_DEVICE" ? t("taskWearTitle") : t("taskBannerTitle")}
          </p>
          <p className="text-sm text-foreground-muted mt-0.5">{task.message}</p>

          {task.dueAt && (
            <p
              className={`text-xs mt-1 flex items-center gap-1 ${isOverdue ? "text-warn" : "text-foreground-muted"}`}
            >
              <Clock size={12} />
              {isOverdue ? t("taskOverdue") : t("taskDue")}:{" "}
              {new Date(task.dueAt).toLocaleString("de-CH")}
            </p>
          )}

          {task.media?.filePath && (
            <div className="mt-3">
              {task.media.mediaType === "image" ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={`/api/uploads/${task.media.filePath}`}
                  alt="Keyholder-Bild"
                  className="rounded-lg max-h-64 object-contain"
                />
              ) : (
                <video
                  src={`/api/uploads/${task.media.filePath}`}
                  controls
                  className="rounded-lg max-h-64 w-full"
                />
              )}
            </div>
          )}

          {task.type === "WEAR_DEVICE" ? (
            /* WEAR_DEVICE: no text response needed — one-tap confirm */
            <Button
              size="sm"
              variant="secondary"
              className="mt-3"
              onClick={() => onComplete(task.id, t("taskWearDefaultResponse"))}
              loading={saving}
            >
              {t("taskComplete")}
            </Button>
          ) : !expanded ? (
            <button
              onClick={() => setExpanded(true)}
              className="mt-2 text-sm font-medium text-foreground underline underline-offset-2"
            >
              {t("taskComplete")}
            </button>
          ) : (
            <div className="mt-3 space-y-2">
              <textarea
                value={response}
                onChange={(e) => setResponse(e.target.value)}
                placeholder={t("taskResponsePlaceholder")}
                rows={3}
                className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-focus-ring"
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={handleSubmit}
                  loading={saving}
                  disabled={!response.trim()}
                >
                  {t("taskSubmit")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setExpanded(false)}>
                  {t("taskCancel")}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function KeyholderChatClient({ enabled, initialMessages, initialTasks }: Props) {
  const t = useTranslations("keyholderChat");

  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [tasks, setTasks] = useState<KeyholderTask[]>(initialTasks);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || streaming) return;

    setInput("");
    setError(null);

    const userMsg: ChatMessage = {
      id: uid(),
      role: "user",
      content: text,
      createdAt: new Date().toISOString(),
    };
    const streamingMsg: ChatMessage = {
      id: uid(),
      role: "assistant",
      content: "",
      createdAt: new Date().toISOString(),
      streaming: true,
    };

    setMessages((prev) => [...prev, userMsg, streamingMsg]);
    setStreaming(true);

    try {
      const res = await fetch("/api/ai-keyholder/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });

      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({ error: "Fehler" }));
        throw new Error(err.error ?? "Verbindungsfehler");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let accumulated = "";
      let finalId = streamingMsg.id;
      const collectedPills: ActionPill[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const raw = decoder.decode(value, { stream: true });
        for (const line of raw.split("\n")) {
          const trimmed = line.replace(/^data: /, "").trim();
          if (!trimmed) continue;
          try {
            const parsed = JSON.parse(trimmed) as {
              text?: string;
              done?: boolean;
              messageId?: string;
              error?: string;
              actionExecuted?: ActionPill;
            };
            if (parsed.error) throw new Error(parsed.error);
            if (parsed.text) {
              accumulated += parsed.text;
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === streamingMsg.id ? { ...m, content: accumulated } : m,
                ),
              );
            }
            if (parsed.actionExecuted) {
              collectedPills.push(parsed.actionExecuted);
              // Show pill immediately during streaming
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === streamingMsg.id
                    ? { ...m, actionPills: [...(m.actionPills ?? []), parsed.actionExecuted!] }
                    : m,
                ),
              );
            }
            if (parsed.done && parsed.messageId) {
              finalId = parsed.messageId;
            }
          } catch (e) {
            if (e instanceof SyntaxError) continue; // skip malformed JSON
            throw e; // re-throw server errors so outer catch shows them
          }
        }
      }

      setMessages((prev) =>
        prev.map((m) =>
          m.id === streamingMsg.id
            ? { ...m, id: finalId, content: accumulated, streaming: false, actionPills: collectedPills }
            : m,
        ),
      );
    } catch (e) {
      setError(String(e));
      setMessages((prev) => prev.filter((m) => m.id !== streamingMsg.id));
    } finally {
      setStreaming(false);
      inputRef.current?.focus();
    }
  }, [input, streaming]);

  const completeTask = useCallback(async (taskId: string, responseText: string) => {
    const res = await fetch("/api/ai-keyholder/tasks", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId, responseText }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Fehler" }));
      setError(err.error ?? "Fehler beim Abschließen der Aufgabe");
      return;
    }
    const { aiReactionText } = (await res.json()) as { aiReactionText: string };
    setTasks((prev) => prev.filter((t) => t.id !== taskId));
    setMessages((prev) => [
      ...prev,
      {
        id: uid(),
        role: "assistant",
        content: aiReactionText,
        createdAt: new Date().toISOString(),
      },
    ]);
  }, []);

  if (!enabled) {
    return (
      <div className="w-full max-w-2xl mx-auto px-4 py-8">
        <EmptyState
          icon={<Lock size={32} />}
          title={t("notEnabledTitle")}
          description={t("notEnabledDesc")}
        />
      </div>
    );
  }

  return (
    <div className="w-full max-w-2xl mx-auto px-4 flex flex-col h-[calc(100vh-8rem)]">
      {/* Header */}
      <div className="py-4 shrink-0">
        <h1 className="text-lg font-semibold text-foreground">{t("title")}</h1>
        <p className="text-sm text-foreground-muted">{t("subtitle")}</p>
      </div>

      {/* Open tasks */}
      {tasks.length > 0 && (
        <div className="shrink-0">
          {tasks.map((task) => (
            <TaskBanner key={task.id} task={task} t={t} onComplete={completeTask} />
          ))}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="shrink-0 mb-3 text-sm text-warn bg-warn-bg border border-[var(--color-warn-border)] rounded-xl px-4 py-3">
          {error}
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto py-2">
        {messages.filter((m) => m.role !== "system" || EVENT_PATTERNS.some((p) => m.content.includes(p.prefix))).length === 0 ? (
          <EmptyState
            icon={<MessageCircle size={28} />}
            title={t("emptyTitle")}
            description={t("emptyDesc")}
          />
        ) : (
          messages.map((m) => <ChatBubble key={m.id} message={m} t={t} />)
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="shrink-0 pb-4 pt-2 border-t border-border">
        <div className="flex gap-2 items-end">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
              }
            }}
            placeholder={t("inputPlaceholder")}
            rows={1}
            disabled={streaming}
            className="flex-1 rounded-xl border border-border bg-surface px-4 py-3 text-sm text-foreground placeholder:text-foreground-muted resize-none focus:outline-none focus:ring-2 focus:ring-focus-ring disabled:opacity-50 max-h-32 overflow-auto"
            style={{ fieldSizing: "content" } as React.CSSProperties}
          />
          <Button
            onClick={sendMessage}
            disabled={!input.trim() || streaming}
            size="default"
            icon={streaming ? <Spinner size="sm" /> : <Send size={16} />}
            aria-label={t("sendLabel")}
          />
        </div>
        <p className="text-xs text-foreground-muted mt-1.5 text-center">{t("inputHint")}</p>
      </div>
    </div>
  );
}
