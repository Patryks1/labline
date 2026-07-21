import { useState } from 'react'
import type { PostTrainStage, TrainingJob } from '../../../../sim/types'
import { formatParams } from '../../../../sim/balance/training'
import { formatTokens, DATA_DOMAINS, DATA_DOMAIN_META } from '../../../../sim/balance/data'
import { money, num } from '../../format'
import { GameCard, LiveDot, MeterBar, StatRow } from '../../ui/kit'
import { HudButton, StatusChip } from '../../ui/HudPrimitives'
import { ResearchUnlockLink } from '../../ui/ResearchUnlockLink'
import { TrainingLossChart } from './TrainingLossChart'
import { SafetyCampaignSection } from './SafetyCampaignSection'
import type { Model, SafetyCampaign, SafetyCampaignIntensity } from '../../../../sim/types'

export function ActiveTrainingCard({
  job,
  trainingPoolPf,
  jobs,
  unlocked,
  day,
  onPriority,
  onPause,
  onCancel,
  onRelease,
  onBenchmark,
  onKeepInternal,
  onSelectPostTrain,
  safetyProps,
}: {
  job: TrainingJob
  trainingPoolPf: number
  jobs: TrainingJob[]
  unlocked: string[]
  day: number
  onPriority: (jobId: string, priority: number, reservedPf?: number) => void
  onPause: (jobId: string, paused: boolean) => void
  onCancel: (jobId: string) => void
  onRelease: (jobId: string) => void
  onBenchmark: (jobId: string) => void
  onKeepInternal: (jobId: string) => void
  onSelectPostTrain: (jobId: string, stage: Exclude<PostTrainStage, 'none'>) => void
  safetyProps?: {
    model: Model | null
    campaign: SafetyCampaign | null
    intensity: SafetyCampaignIntensity
    setIntensity: (value: SafetyCampaignIntensity) => void
    researchers: number
    setResearchers: (value: number) => void
    researcherCount: number
    estimate: ReturnType<typeof import('../../../../sim/systems/safetyCampaigns').safetyCampaignEstimate> | null
    onStart: () => void
    onCancel: () => void
  }
}) {
  const [cancelConfirm, setCancelConfirm] = useState(false)
  const progress = job.targetPfDays > 0 ? job.progressPfDays / job.targetPfDays : 0
  const pct = Math.round(Math.max(0, Math.min(1, progress)) * 100)
  const prioritySum = Math.max(
    1,
    jobs.reduce((sum, candidate) => sum + (candidate.paused || candidate.failed ? 0 : candidate.computePriority ?? 50), 0),
  )
  const allocatedPf =
    job.failed || job.paused
      ? 0
      : trainingPoolPf * ((job.computePriority ?? 50) / prioritySum)
  const remainingPf = Math.max(0, job.targetPfDays - job.progressPfDays)
  const etaDays = allocatedPf > 0.05 ? remainingPf / allocatedPf : Infinity
  const currentLoss = job.lossHistory?.at(-1)?.loss
  const done = !job.failed && job.progressPfDays >= job.targetPfDays
  const modeLabel =
    job.mode === 'distill'
      ? `Distill · teacher ${Math.round((job.distillTeacherShare ?? 0.72) * 100)}%`
      : job.mode === 'continue'
        ? 'Continuation'
        : 'Pretrain'

  return (
    <GameCard
      eyebrow="Live training"
      title={
        <span className="flex items-center gap-2">
          <LiveDot className={job.failed ? 'text-danger' : job.paused ? 'text-amber' : 'text-train'} />
          <span className="truncate">{job.name}</span>
        </span>
      }
      tone={job.failed ? 'danger' : 'train'}
      live={!job.failed && !job.paused && !done}
      className={!job.failed && !done ? 'live-glow' : ''}
      actions={
        <div className="flex items-center gap-1.5">
          <StatusChip tone={job.failed ? 'danger' : job.paused ? 'warning' : done ? 'positive' : 'warning'}>
            {job.failed ? 'Failed' : job.paused ? 'Paused' : done ? 'Ready' : 'Training'}
          </StatusChip>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-[0.8125rem] text-muted">
            {modeLabel} · {job.family}
            {job.family === 'moe'
              ? ` · ${formatParams(job.targetParamsB)} / ${formatParams(job.activeParamsB ?? 0)} active`
              : ` · ${formatParams(job.targetParamsB)}`}
          </p>
          <p className="font-mono text-[0.8125rem] tabular-nums text-train">
            {num(allocatedPf, 1)} PF/d · priority {job.computePriority ?? 50}
          </p>
        </div>

        <MeterBar
          label="Progress"
          value={progress}
          detail={`${pct}% · ${etaDays === Infinity ? 'stalled' : `~${etaDays.toFixed(0)}d left`}`}
          tone="train"
          live={!job.failed && !job.paused && !done}
        />

        <div className="grid grid-cols-3 gap-2">
          <StatRow label="Loss" value={currentLoss == null ? '—' : currentLoss.toFixed(3)} strong />
          <StatRow
            label="Data"
            value={formatTokens(
              job.trainMTok + job.verifyMTok || job.dataPlan?.totalMTok || job.dataPlan?.totalUnits || 0,
            )}
          />
          <StatRow
            label="Burn"
            value={job.cashBurnPerDay ? `${money(job.cashBurnPerDay)}/d` : '—'}
            tone="warning"
          />
        </div>

        {job.failed ? (
          <div className="rounded-md border border-danger/35 bg-danger/10 p-2.5">
            <div className="flex items-center justify-between gap-2">
              <strong className="text-[0.8125rem] text-danger">
                {job.failureStage === 'base' ? 'Base training failed' : `${job.failureStage?.toUpperCase()} failed`}
              </strong>
              <span className="font-mono text-[0.6875rem] tabular-nums text-muted">Day {job.failureDay ?? day}</span>
            </div>
            <p className="mt-1 text-[0.75rem] text-muted">{job.failureReason}</p>
          </div>
        ) : null}

        {job.stallReason ? <p className="text-[0.75rem] text-amber">{job.stallReason}</p> : null}

        {job.dataPlan ? (
          <p className="truncate text-[0.75rem] text-muted">
            Mix:{' '}
            {DATA_DOMAINS.filter((d) => (job.dataPlan!.weights[d] ?? 0) >= 0.05)
              .map((d) => `${DATA_DOMAIN_META[d].label} ${Math.round((job.dataPlan!.weights[d] ?? 0) * 100)}%`)
              .join(' · ')}
          </p>
        ) : null}

        {job.postTrain !== 'none' ? (
          <MeterBar
            label={`Post-train: ${job.postTrain}`}
            value={job.postTrainTarget > 0 ? job.postTrainProgress / job.postTrainTarget : 0}
            detail={`${num(job.postTrainProgress, 1)} / ${num(job.postTrainTarget, 1)}`}
            tone="research"
          />
        ) : null}

        <TrainingLossChart history={job.lossHistory ?? []} failed={job.failed ?? false} />

        {!job.failed ? (
          <label className="block text-[0.6875rem] uppercase tracking-[0.12em] text-muted">
            Compute priority · {job.computePriority ?? 50}/100
            <input
              type="range"
              min={10}
              max={100}
              step={5}
              value={job.computePriority ?? 50}
              onChange={(event) => onPriority(job.id, Number(event.target.value), job.reservedPf)}
              className="mt-1 w-full"
            />
          </label>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {job.failed ? (
            <HudButton variant="danger" onClick={() => onCancel(job.id)}>
              Delete failed run
            </HudButton>
          ) : done ? (
            <>
              <HudButton
                variant="primary"
                onClick={() => onRelease(job.id)}
              >
                Release
              </HudButton>
              <HudButton onClick={() => onBenchmark(job.id)}>Run benchmarks</HudButton>
              <HudButton onClick={() => onKeepInternal(job.id)}>Keep internal</HudButton>
              <HudButton
                variant={cancelConfirm ? 'danger' : 'ghost'}
                onClick={() => {
                  if (cancelConfirm) onCancel(job.id)
                  else setCancelConfirm(true)
                }}
              >
                {cancelConfirm ? 'Confirm delete' : 'Delete run'}
              </HudButton>
            </>
          ) : (
            <>
              <HudButton onClick={() => onPause(job.id, !job.paused)}>
                {job.paused ? 'Resume' : 'Pause'}
              </HudButton>
              <HudButton
                variant={cancelConfirm ? 'danger' : 'ghost'}
                onClick={() => {
                  if (cancelConfirm) onCancel(job.id)
                  else setCancelConfirm(true)
                }}
              >
                {cancelConfirm ? 'Confirm cancel' : 'Cancel'}
              </HudButton>
            </>
          )}
        </div>

        {done ? (
          <div className="rounded-md border border-research/25 bg-research/5 p-2.5">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className="text-[0.8125rem] font-semibold text-bone">Optional post-training</span>
              <span className="font-mono text-[0.6875rem] text-muted">choose next stage</span>
            </div>
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
              {(['sft', 'rlhf', 'process', 'tools'] as Exclude<PostTrainStage, 'none'>[]).map((stage) => {
                const locked =
                  (stage === 'rlhf' && !unlocked.includes('align_rlhf')) ||
                  (stage === 'process' && !unlocked.includes('align_process'))
                const busy = job.postTrain !== 'none' && job.postTrainProgress < job.postTrainTarget
                return (
                  <button
                    key={stage}
                    type="button"
                    disabled={locked || busy}
                    title={locked ? 'Research required' : busy ? 'Stage in progress' : undefined}
                    onClick={() => onSelectPostTrain(job.id, stage)}
                    className={`rounded-md border px-2 py-1.5 text-[0.6875rem] uppercase tracking-[0.12em] disabled:cursor-not-allowed disabled:opacity-40 ${
                      job.postTrain === stage
                        ? 'border-research bg-research/20 text-research'
                        : 'border-line text-muted'
                    }`}
                  >
                    {stage}
                  </button>
                )
              })}
            </div>
            {job.postTrain === 'sft' && !unlocked.includes('align_rlhf') ? (
              <ResearchUnlockLink className="mt-2" nodeId="align_rlhf" label="Unlock RLHF Pipeline for the next post-train stage" />
            ) : null}
            {job.postTrain === 'rlhf' && !unlocked.includes('align_process') ? (
              <ResearchUnlockLink className="mt-2" nodeId="align_process" label="Unlock Process Reward Models for the next stage" />
            ) : null}
          </div>
        ) : null}

        {safetyProps ? <SafetyCampaignSection {...safetyProps} compact /> : null}
      </div>
    </GameCard>
  )
}
