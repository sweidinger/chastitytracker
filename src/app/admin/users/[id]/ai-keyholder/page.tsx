import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { assertKeyholderOrAdmin } from "@/lib/authGuards";
import { getTranslations } from "next-intl/server";
import AiKeyholderConfigForm from "./AiKeyholderConfigForm";
import AiKeyholderStatusPanel from "./AiKeyholderStatusPanel";
import { effectiveMood } from "@/lib/aiKeyholder/moodService";

export default async function AiKeyholderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const { isGlobalAdmin } = await assertKeyholderOrAdmin(id);
  if (!isGlobalAdmin) redirect(`/admin/users/${id}`);

  const [user, config, t] = await Promise.all([
    prisma.user.findUnique({ where: { id }, select: { id: true, username: true } }),
    prisma.aiKeyholderConfig.findUnique({ where: { userId: id } }),
    getTranslations("admin"),
  ]);

  if (!user) redirect("/admin");

  return (
    <div className="flex flex-col gap-4">
      <div className="mb-1">
        <h2 className="text-base font-semibold text-foreground">{t("aikhPageTitle")}</h2>
        <p className="text-sm text-foreground-muted mt-0.5">{t("aikhPageDesc")}</p>
      </div>

      {/* Live status panel — always shown (fetches via client) */}
      <AiKeyholderStatusPanel
        userId={id}
        nextRunAt={config?.nextRunAt?.toISOString() ?? null}
        randomIntervalMinMin={config?.randomIntervalMinMin ?? 15}
        randomIntervalMinMax={config?.randomIntervalMinMax ?? 120}
        moodScore={config ? effectiveMood({ moodScore: config.moodScore, moodUpdatedAt: config.moodUpdatedAt }) : null}
      />

      {/* Configuration form */}
      <AiKeyholderConfigForm
        userId={id}
        initial={
          config
            ? {
                enabled: config.enabled,
                llmProvider: config.llmProvider,
                ollamaBaseUrl: config.ollamaBaseUrl,
                ollamaModel: config.ollamaModel,
                systemPrompt: config.systemPrompt,
                intensity: config.intensity,
                moodScore: config.moodScore,
                proactiveCheckinMinHours: config.proactiveCheckinMinHours,
                visionEnabled: config.visionEnabled,
                cronExpression: config.cronExpression,
                randomIntervalMinMin: config.randomIntervalMinMin,
                randomIntervalMinMax: config.randomIntervalMinMax,
                nextRunAt: config.nextRunAt?.toISOString() ?? null,
                mediaEnabled: config.mediaEnabled,
                comfyUiBaseUrl: config.comfyUiBaseUrl,
                mediaProvider: config.mediaProvider,
                mediaModelName: config.mediaModelName,
                mediaLlmProvider: config.mediaLlmProvider,
                mediaLlmBaseUrl: config.mediaLlmBaseUrl,
                mediaLlmModel: config.mediaLlmModel,
                mediaPersonaAnchor: config.mediaPersonaAnchor,
                mediaSeed: config.mediaSeed,
                avatarPath: config.avatarPath,
                mediaApiKeySet: !!config.mediaApiKeyEnc,
                mediaPromptTemplates: config.mediaPromptTemplates,
                lastRunAt: config.lastRunAt?.toISOString() ?? null,
              }
            : null
        }
      />
    </div>
  );
}
