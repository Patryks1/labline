import type { Model, SafetyCampaign, SafetyCampaignIntensity } from '../../../../sim/types'
import { safetyCampaignEstimate } from '../../../../sim/systems/safetyCampaigns'
import { formatTokens } from '../../../../sim/balance/data'
import { money } from '../../format'
import { GameCard, MeterBar, StatRow, BlockerList } from '../../ui/kit'
import { HudButton } from '../../ui/HudPrimitives'

export function SafetyCampaignSection({
  model,
  campaign,
  intensity,
  setIntensity,
  researchers,
  setResearchers,
  researcherCount,
  estimate,
  onStart,
  onCancel,
  compact = false,
}: {
  model: Model | null
  campaign: SafetyCampaign | null
  intensity: SafetyCampaignIntensity
  setIntensity: (value: SafetyCampaignIntensity) => void
  researchers: number
  setResearchers: (value: number) => void
  researcherCount: number
  estimate: ReturnType<typeof safetyCampaignEstimate> | null
  onStart: () => void
  onCancel: () => void
  compact?: boolean
}) {
  void compact
  if (campaign && (!model || campaign.modelId === model.id)) {
    const trainingProgress = campaign.progressTrainingPfDays / Math.max(0.01, campaign.targetTrainingPfDays)
    const researchProgress = campaign.progressResearchPfDays / Math.max(0.01, campaign.targetResearchPfDays)
    return (
      <GameCard
        tone="research"
        live
        eyebrow="Safety campaign"
        title={campaign.modelName}
        actions={
          <HudButton type="button" variant="danger" onClick={onCancel} className="!px-2 !py-1 text-[0.6875rem]">
            Cancel
          </HudButton>
        }
      >
        <p className="mb-2 font-mono text-[0.6875rem] uppercase tracking-[0.12em] text-research">
          {campaign.intensity} · deployed revision stays live
        </p>
        <div className="space-y-2">
          <MeterBar
            label="Training compute"
            value={trainingProgress}
            detail={`${campaign.progressTrainingPfDays.toFixed(2)} / ${campaign.targetTrainingPfDays.toFixed(2)} PF-d`}
            tone="research"
            live
          />
          <MeterBar
            label="Research compute"
            value={researchProgress}
            detail={`${campaign.progressResearchPfDays.toFixed(2)} / ${campaign.targetResearchPfDays.toFixed(2)} PF-d`}
            tone="research"
            live
          />
        </div>
        <p className="mt-2 font-mono text-[0.6875rem] text-muted">
          {campaign.assignedResearchers} researchers · safety set {formatTokens(campaign.safetyDataMTok)} · Q
          {campaign.safetyDataQuality.toFixed(2)}
        </p>
      </GameCard>
    )
  }

  if (!model) return null

  const blockers = estimate?.reason ? [{ text: estimate.reason, tone: 'warning' as const }] : []

  return (
    <GameCard
      tone="research"
      eyebrow="Safety post-training"
      title={model.name}
      actions={
        <span className="font-mono text-[0.6875rem] text-muted">
          {model.safetyTraining?.campaigns ?? 0} complete
        </span>
      }
    >
      <p className="mb-2 text-[0.8125rem] text-muted">
        Safer revision for this checkpoint — deployed weights stay live.
      </p>
      <div className="grid grid-cols-3 gap-1.5">
        {(['targeted', 'standard', 'frontier'] as SafetyCampaignIntensity[]).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setIntensity(option)}
            className={`rounded-md border px-2 py-1.5 text-[0.6875rem] capitalize transition ${
              intensity === option
                ? 'border-research/50 bg-research/15 text-research'
                : 'border-line text-muted hover:text-bone'
            }`}
          >
            {option}
          </button>
        ))}
      </div>
      {estimate ? (
        <div className="mt-2 space-y-0.5">
          <StatRow label="Train" value={`${estimate.trainingPfDays.toFixed(2)} PF-d`} />
          <StatRow label="Research" value={`${estimate.researchPfDays.toFixed(2)} PF-d`} tone="research" />
          <StatRow label="Cash" value={money(estimate.cashBudget)} />
        </div>
      ) : null}
      <label className="mt-2 block text-[0.6875rem] text-muted">
        Researchers {researchers} / {researcherCount}
        <input
          type="range"
          min={1}
          max={Math.max(1, researcherCount)}
          value={Math.min(Math.max(1, researcherCount), researchers)}
          onChange={(event) => setResearchers(Number(event.target.value))}
          className="mt-1 w-full"
        />
      </label>
      <div className="mt-2 space-y-2">
        <BlockerList items={blockers} />
        <HudButton
          type="button"
          variant="primary"
          disabled={!estimate?.ok}
          title={!estimate?.ok ? estimate?.reason ?? 'Cannot start safety campaign' : undefined}
          onClick={onStart}
          className="w-full !bg-research !text-void"
        >
          Start {intensity} campaign
        </HudButton>
      </div>
    </GameCard>
  )
}
