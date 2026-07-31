import { useState } from 'react'
import type { PostTrainStage, TrainingJob } from '../../../../sim/types'
import {
  canReleaseTrainingJob,
  earlyReleasePenalty,
  trainingMinimumStatus,
  type TrainingResourceAllocation,
} from '../../../../sim/systems/training'
import { formatParams } from '../../../../sim/balance/training'
import { formatTokens, DATA_DOMAINS, DATA_DOMAIN_META } from '../../../../sim/balance/data'
import { money, num } from '../../format'
import { GameCard, LiveDot, MeterBar, StatRow } from '../../ui/kit'
import { HudButton, StatusChip } from '../../ui/HudPrimitives'
import { ResearchUnlockLink } from '../../ui/ResearchUnlockLink'
import { TrainingLossChart } from './TrainingLossChart'
import { SafetyCampaignSection } from './SafetyCampaignSection'
import type { Model, SafetyCampaign, SafetyCampaignIntensity } from '../../../../sim/types'
import {
  classifyTrainingStatus,
  trainingReleaseDisabledReason,
  trainingRemainingTime,
} from './trainingPresentation'

type TrainStage = Exclude<PostTrainStage, 'none'>

const POST_TRAIN_META: Record<
  TrainStage,
  { feature: string; research?: string; target: number; compute: string; data: string; spike: string }
> = {
  sft: {
    feature: 'Instruction following',
    target: 4,
    compute: '~4 PF target units',
    data: 'Curated instruction data',
    spike: '+0.2–0.5, then recovery',
  },
  rlhf: {
    feature: 'Preference alignment',
    research: 'align_rlhf',
    target: 8,
    compute: '~8 PF target units',
    data: 'Preference comparisons',
    spike: '+0.3–0.7, then recovery',
  },
  process: {
    feature: 'Process reward',
    research: 'align_process',
    target: 10,
    compute: '~10 PF target units',
    data: 'Step-level judgments',
    spike: '+0.4–0.8, then recovery',
  },
  tools: {
    feature: 'Tool use in benchmarks',
    target: 6,
    compute: '~6 PF target units',
    data: 'Tool-call trajectories',
    spike: '+0.2–0.6, then recovery',
  },
}

export function ActiveTrainingCard({
  job,
  trainingPoolPf,
  resources,
  jobs,
  unlocked,
  day,
  onPriority,
  onPause,
  onCancel,
  onRelease,
  onBenchmark,
  onKeepInternal,
  onExtend,
  onSelectPostTrain,
  safetyProps,
}: {
  job: TrainingJob
  trainingPoolPf: number
  resources?: TrainingResourceAllocation
  jobs: TrainingJob[]
  unlocked: string[]
  day: number
  onPriority: (jobId: string, priority: number, reservedPf?: number) => void
  onPause: (jobId: string, paused: boolean) => void
  onCancel: (jobId: string) => void
  onRelease: (jobId: string) => void
  onBenchmark: (jobId: string) => void
  onKeepInternal: (jobId: string) => void
  onExtend?: (jobId: string) => void
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
    resources
      ? resources.effectivePf
      : job.failed || job.paused
      ? 0
      : trainingPoolPf * ((job.computePriority ?? 50) / prioritySum)
  const { calendarRemaining, computeDone, etaDays } = trainingRemainingTime({
    targetPfDays: job.targetPfDays,
    progressPfDays: job.progressPfDays,
    allocatedPf,
    minCalendarDays: job.minCalendarDays,
    daysElapsed: job.daysElapsed,
  })
  const currentLoss = job.lossHistory?.at(-1)?.loss
  const recommended = job.recommendedPfDays ?? job.targetPfDays
  const atRecommended = job.progressPfDays + 1e-9 >= recommended
  const recommendedProgress = recommended > 0 ? job.progressPfDays / recommended : progress
  const releaseGate = canReleaseTrainingJob(job)
  const releaseDisabledReason = trainingReleaseDisabledReason(releaseGate)
  const minimum = trainingMinimumStatus(job)
  const earlyPenalty = earlyReleasePenalty(job)
  const economics = job.economics
  const snapshots = job.benchmarkSnapshots ?? []
  const canBenchmarkMid = !job.failed && progress >= 0.1 && (job.lastBenchmarkDay == null || day - job.lastBenchmarkDay >= 7)
  const done = minimum.ok
  const awaiting = Boolean(job.awaitingDecision)
  const {
    calendarWaiting,
    diagnosticStall,
    incompatible,
    memoryBlocked,
    powerBlocked,
    ramBlocked,
    statusLabel,
    unstable,
    visuallyBlocked,
  } = classifyTrainingStatus({
    failed: job.failed,
    paused: job.paused,
    stallReason: job.stallReason,
    resources,
    completeReady: minimum.completeReady,
    plateaued: minimum.plateaued,
    computeDone,
    calendarRemaining,
  })
  const statusTone = job.failed || memoryBlocked || powerBlocked || incompatible || unstable
    ? 'danger'
    : job.paused || calendarWaiting
      ? 'warning'
      : minimum.completeReady
        ? 'positive'
        : 'warning'
  const etaDetail =
    etaDays === Infinity
      ? 'stalled'
      : calendarWaiting
        ? `calendar hold · ${calendarRemaining}d left`
        : computeDone
          ? 'compute done'
          : `~${etaDays.toFixed(0)}d left`
  const modeLabel =
    job.mode === 'distill'
      ? `Distill · teacher ${Math.round((job.distillTeacherShare ?? 0.72) * 100)}%`
      : job.mode === 'continue'
        ? 'Continuation'
        : 'Pretrain'
  const jobWithEnergy = job as TrainingJob & {
    energyMWh?: number
    cumulativeMWh?: number
    energyMwDays?: number
    mwDays?: number
    powerMw?: number
    trainingPowerMw?: number
  }
  const directMWh = jobWithEnergy.energyMWh ?? jobWithEnergy.cumulativeMWh
  const directMwDays = jobWithEnergy.energyMwDays ?? jobWithEnergy.mwDays
  const powerMw = jobWithEnergy.trainingPowerMw ?? jobWithEnergy.powerMw
  const estimatedMwDays = powerMw != null ? Math.max(0, powerMw) * Math.max(0, job.daysElapsed ?? 0) : undefined
  const chartMwDays = directMwDays ?? (directMWh != null ? directMWh / 24 : estimatedMwDays)
  const chartMWh = directMWh ?? (chartMwDays != null ? chartMwDays * 24 : undefined)
  const energyEstimated = directMWh == null && directMwDays == null && chartMWh != null
  const stageHistory = new Set((job.lossHistory ?? []).filter((point) => point.stage !== 'base').map((point) => point.stage as TrainStage))

  return (
    <GameCard
      eyebrow="Live training"
      title={
        <span className="flex items-center gap-2">
          <LiveDot className={job.failed || visuallyBlocked ? 'text-danger' : job.paused || calendarWaiting ? 'text-amber' : 'text-train'} />
          <span className="truncate">{job.name}</span>
        </span>
      }
      tone={job.failed || visuallyBlocked ? 'danger' : 'train'}
      live={!job.failed && !job.paused && !done && !visuallyBlocked && !calendarWaiting}
      className={!job.failed && !done && !visuallyBlocked && !calendarWaiting ? 'live-glow' : ''}
      actions={
        <div className="flex items-center gap-1.5">
          <StatusChip tone={statusTone}>{statusLabel}</StatusChip>
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
          <div className="text-right font-mono text-[0.75rem] tabular-nums">
            <p className="text-train">
              {num(allocatedPf, 1)} PF/d · priority {job.computePriority ?? 50}
            </p>
            {resources ? (
              <>
                <p className={resources.bottleneck === 'none' ? 'text-muted' : 'text-danger'}>
                  HBM {num(resources.ramAllocatedGb, 0)} / {num(resources.ramRequiredGb, 0)} GB · host RAM {num(resources.systemRamAllocatedGb, 0)} / {num(resources.systemRamRequiredGb, 0)} GB
                </p>
                <p className={resources.bottleneck === 'none' ? 'text-muted' : 'text-danger'}>
                  Bottleneck: {resources.bottleneck === 'none' ? 'none' : resources.bottleneck.replace('_', ' ')}
                </p>
              </>
            ) : null}
          </div>
        </div>

        <MeterBar
          label="Progress"
          value={progress}
          detail={`${pct}% · ${etaDetail} · calendar ${job.daysElapsed ?? 0}/${job.minCalendarDays ?? 0}d`}
          tone="train"
          live={!job.failed && !job.paused && !done && !ramBlocked && !calendarWaiting}
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

        {diagnosticStall ? <p className="text-[0.75rem] text-amber">{diagnosticStall}</p> : null}
        {calendarWaiting && !job.stallReason ? (
          <p className="text-[0.75rem] text-amber">
            {minimum.reason ??
              `${calendarRemaining} funded active calendar day${calendarRemaining === 1 ? '' : 's'} remain for integration and validation.`}
          </p>
        ) : null}
        {ramBlocked && !job.stallReason ? (
          <p className="text-[0.75rem] text-danger">
            Training RAM is a hard limit. Raise Training allocation, add memory, or pause another run.
          </p>
        ) : null}

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

        {(economics || snapshots.length > 0) ? (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {economics ? (
              <>
                <StatRow label="Setup" value={money(economics.setupCost)} />
                <StatRow label="Data" value={money(economics.dataCost)} />
                <StatRow label="Training" value={money(economics.trainingCostAccrued)} tone="warning" />
              </>
            ) : null}
            <StatRow
              label="Recommended"
              value={`${Math.round(Math.min(100, recommendedProgress * 100))}%`}
            />
          </div>
        ) : null}

        {snapshots.length ? (
          <div className="rounded-md border border-line/50 bg-void/25 p-2.5">
            <p className="hud-eyebrow mb-1.5">Benchmarks during training</p>
            <div className="space-y-1">
              {snapshots.slice(-4).map((snap, index) => (
                <div key={`${snap.day}-${index}`} className="flex items-center justify-between gap-2 font-mono text-[0.6875rem] tabular-nums">
                  <span className="text-muted">D{snap.day} · {(snap.progress * 100).toFixed(0)}%</span>
                  <span className="text-bone">cap {snap.capability.toFixed(1)} · safety {snap.safety.toFixed(1)}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <TrainingLossChart
          history={job.lossHistory ?? []}
          failed={job.failed ?? false}
          energyMWh={chartMWh}
          mwDays={chartMwDays}
          energyEstimated={energyEstimated}
        />

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
          ) : done || awaiting ? (
            <>
              {minimum.completeReady ? (
                <HudButton
                  variant="primary"
                  disabled={!releaseGate.ok}
                  title={releaseDisabledReason}
                  onClick={() => onRelease(job.id)}
                >
                  Release
                </HudButton>
              ) : (
                <HudButton
                  variant="primary"
                  disabled={!releaseGate.ok || releaseGate.releaseKind !== 'early'}
                  title={releaseDisabledReason ?? 'Release this plateaued checkpoint with degraded quality.'}
                  onClick={() => onRelease(job.id)}
                >
                  Early release
                </HudButton>
              )}
              <HudButton onClick={() => onBenchmark(job.id)}>Run benchmarks</HudButton>
              <HudButton onClick={() => onKeepInternal(job.id)}>Keep internal</HudButton>
              {onExtend && (awaiting || atRecommended) ? (
                <HudButton variant="secondary" onClick={() => onExtend(job.id)}>
                  Extend 10 days
                </HudButton>
              ) : null}
              <HudButton
                variant={cancelConfirm ? 'danger' : 'ghost'}
                onClick={() => {
                  if (cancelConfirm) onCancel(job.id)
                  else setCancelConfirm(true)
                }}
              >
                {cancelConfirm ? 'Confirm delete' : 'Delete run'}
              </HudButton>
              {releaseDisabledReason ? (
                <p className="basis-full text-[0.75rem] text-amber">{releaseDisabledReason}</p>
              ) : releaseGate.releaseKind === 'early' || minimum.earlyReleaseReady ? (
                <p className="basis-full text-[0.75rem] text-amber">
                  Degraded checkpoint: capability ×{earlyPenalty.capabilityMultiplier.toFixed(2)}, benchmarks ×{earlyPenalty.benchmarkMultiplier.toFixed(2)}, reliability ×{earlyPenalty.reliabilityMultiplier.toFixed(2)}.
                </p>
              ) : null}
            </>
          ) : (
            <>
              <HudButton onClick={() => onPause(job.id, !job.paused)}>
                {job.paused ? 'Resume' : 'Pause'}
              </HudButton>
              <HudButton
                disabled={!canBenchmarkMid}
                title={!canBenchmarkMid ? 'Benchmarks unlock after 10% progress, then every 7 days.' : undefined}
                onClick={() => onBenchmark(job.id)}
              >
                Benchmark
              </HudButton>
              <HudButton
                variant="primary"
                disabled={!releaseGate.ok || releaseGate.releaseKind !== 'early'}
                title={releaseDisabledReason ?? 'Release this plateaued checkpoint with degraded quality.'}
                onClick={() => onRelease(job.id)}
              >
                Early release
              </HudButton>
              {onExtend && atRecommended ? (
                <HudButton variant="secondary" onClick={() => onExtend(job.id)}>
                  Extend 10 days
                </HudButton>
              ) : null}
              <HudButton
                variant={cancelConfirm ? 'danger' : 'ghost'}
                onClick={() => {
                  if (cancelConfirm) onCancel(job.id)
                  else setCancelConfirm(true)
                }}
              >
                {cancelConfirm ? 'Confirm cancel' : 'Cancel'}
              </HudButton>
              {releaseGate.releaseKind === 'early' || minimum.earlyReleaseReady ? (
                <p className="basis-full text-[0.75rem] text-amber">
                  Early release degrades quality: capability ×{earlyPenalty.capabilityMultiplier.toFixed(2)}, benchmarks ×{earlyPenalty.benchmarkMultiplier.toFixed(2)}, reliability ×{earlyPenalty.reliabilityMultiplier.toFixed(2)}.
                </p>
              ) : releaseDisabledReason ? (
                <p className="basis-full text-[0.75rem] text-muted">Early release locked: {releaseDisabledReason}</p>
              ) : null}
            </>
          )}
        </div>

        {done ? (
          <div className="rounded-md border border-research/25 bg-research/5 p-2.5">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className="text-[0.8125rem] font-semibold text-bone">Optional post-training</span>
              <span className="font-mono text-[0.6875rem] text-muted">choose next stage</span>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {(Object.keys(POST_TRAIN_META) as TrainStage[]).map((stage) => {
                const meta = POST_TRAIN_META[stage]
                const locked = Boolean(meta.research && !unlocked.includes(meta.research))
                const busy = job.postTrain !== 'none' && job.postTrainProgress < job.postTrainTarget
                const applied =
                  (stageHistory.has(stage) && job.postTrain !== stage) ||
                  (job.postTrain === stage && job.postTrainProgress >= job.postTrainTarget)
                const stageTime = allocatedPf > 0.05
                  ? `~${Math.ceil(meta.target / allocatedPf)} active day${Math.ceil(meta.target / allocatedPf) === 1 ? '' : 's'}`
                  : 'Time awaits PF allocation'
                const lockReason = applied
                  ? 'Already applied; post-training stages are one-shot.'
                  : locked
                    ? `Research ${meta.research} required.`
                    : busy
                      ? `${job.postTrain.toUpperCase()} is already in progress.`
                      : undefined
                const stateLabel = applied ? 'done' : locked ? 'locked' : busy ? 'busy' : 'available'
                return (
                  <button
                    key={stage}
                    type="button"
                    disabled={applied || locked || busy}
                    title={lockReason}
                    onClick={() => onSelectPostTrain(job.id, stage)}
                    className={`rounded-md border p-2.5 text-left disabled:cursor-not-allowed disabled:opacity-55 ${
                      job.postTrain === stage
                        ? 'border-research bg-research/20 text-research'
                        : 'border-line text-muted'
                    }`}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <strong className="text-[0.75rem] uppercase tracking-[0.12em] text-bone">{stage}</strong>
                      <span className="font-mono text-[0.625rem] uppercase tracking-[0.1em]">{stateLabel}</span>
                    </span>
                    <span className="mt-1 block text-[0.75rem] text-bone">Gains: {meta.feature}</span>
                    <span className="mt-1 block font-mono text-[0.6875rem] leading-5">
                      {meta.data} · {meta.compute} · {stageTime}
                    </span>
                    <span className="block text-[0.6875rem]">Expected loss spike {meta.spike}</span>
                    {lockReason ? <span className="mt-1 block text-[0.6875rem] text-amber">{lockReason}</span> : null}
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
