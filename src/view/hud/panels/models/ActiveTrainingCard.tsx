import { useState } from 'react'
import type { PostTrainStage, TrainingJob } from '../../../../sim/types'
import {
  canReleaseTrainingJob,
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
  const remainingPf = Math.max(0, job.targetPfDays - job.progressPfDays)
  const calendarRemaining = Math.max(0, (job.minCalendarDays ?? 0) - (job.daysElapsed ?? 0))
  const computeEta = remainingPf <= 1e-9 ? 0 : allocatedPf > 0.05 ? remainingPf / allocatedPf : Infinity
  const etaDays = Math.max(computeEta, calendarRemaining)
  const currentLoss = job.lossHistory?.at(-1)?.loss
  const recommended = job.recommendedPfDays ?? job.targetPfDays
  const atRecommended = job.progressPfDays + 1e-9 >= recommended
  const recommendedProgress = recommended > 0 ? job.progressPfDays / recommended : progress
  const releaseGate = canReleaseTrainingJob(job)
  const economics = job.economics
  const snapshots = job.benchmarkSnapshots ?? []
  const canBenchmarkMid = !job.failed && progress >= 0.1 && (job.lastBenchmarkDay == null || day - job.lastBenchmarkDay >= 7)
  const done = trainingMinimumStatus(job).ok
  const ramBlocked = Boolean(
    resources && (!resources.ramReady || !resources.systemRamReady) && !job.failed && !job.paused && !done,
  )
  const awaiting = Boolean(job.awaitingDecision)
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
          <LiveDot className={job.failed || ramBlocked ? 'text-danger' : job.paused ? 'text-amber' : 'text-train'} />
          <span className="truncate">{job.name}</span>
        </span>
      }
      tone={job.failed || ramBlocked ? 'danger' : 'train'}
      live={!job.failed && !job.paused && !done && !ramBlocked}
      className={!job.failed && !done && !ramBlocked ? 'live-glow' : ''}
      actions={
        <div className="flex items-center gap-1.5">
          <StatusChip tone={job.failed || ramBlocked ? 'danger' : job.paused ? 'warning' : done ? 'positive' : 'warning'}>
            {job.failed ? 'Failed' : ramBlocked ? 'RAM blocked' : job.paused ? 'Paused' : done ? 'Ready' : 'Training'}
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
          detail={`${pct}% · ${etaDays === Infinity ? 'stalled' : `~${etaDays.toFixed(0)}d left`} · calendar ${job.daysElapsed ?? 0}/${job.minCalendarDays ?? 0}d`}
          tone="train"
          live={!job.failed && !job.paused && !done && !ramBlocked}
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
          ) : done || awaiting ? (
            <>
              <HudButton
                variant="primary"
                disabled={!releaseGate.ok}
                title={!releaseGate.ok ? releaseGate.reason : undefined}
                onClick={() => onRelease(job.id)}
              >
                Release
              </HudButton>
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
              {!releaseGate.ok ? (
                <p className="basis-full text-[0.75rem] text-amber">{releaseGate.reason}</p>
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
