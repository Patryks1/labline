import { ArrowCounterClockwise, Brain, CheckCircle, Play, WarningCircle } from '@phosphor-icons/react'
import { useMemo } from 'react'
import { useGameStore } from '../../store/gameStore'
import { useUiStore } from '../../store/uiStore'
import {
  buildTrainingActivity,
  type TrainingActivityAction,
  type TrainingActivityTone,
  type TrainingJobViewModel,
} from './trainingJobViewModel'
import { MeterBar } from './ui/kit'
import { HudButton, StatusChip } from './ui/HudPrimitives'

function chipTone(tone: TrainingActivityTone): 'neutral' | 'positive' | 'warning' | 'danger' {
  return tone
}

function meterTone(tone: TrainingActivityTone): 'positive' | 'warning' | 'danger' | 'train' {
  if (tone === 'danger') return 'danger'
  if (tone === 'positive') return 'positive'
  return 'train'
}

function iconToneClass(job: TrainingJobViewModel): string {
  if (job.issueTone === 'danger') return 'text-danger'
  if (job.issueTone === 'positive') return 'text-mint'
  if (job.issueTone === 'warning') return 'text-amber'
  return 'text-train'
}

function ActivityIcon({ job }: { job: TrainingJobViewModel }) {
  if (job.primaryAction.kind === 'recover') {
    return <ArrowCounterClockwise size="1rem" weight="bold" aria-hidden />
  }
  if (job.primaryAction.kind === 'resume') {
    return <Play size="1rem" weight="fill" aria-hidden />
  }
  if (job.issueTone === 'danger') {
    return <WarningCircle size="1rem" weight="fill" aria-hidden />
  }
  if (job.statusLabel === 'Ready') {
    return <CheckCircle size="1rem" weight="fill" aria-hidden />
  }
  return <Brain size="1rem" weight="duotone" aria-hidden />
}

/** Responsive strip contract mirrored by the mobile shell CSS. */
// oxlint-disable-next-line react/only-export-components
export function mobileTrainingActivityRect({
  viewportWidth,
  viewportHeight,
  mobileNavHeight,
  stripHeight,
  safeLeft = 0,
  safeRight = 0,
}: {
  viewportWidth: number
  viewportHeight: number
  mobileNavHeight: number
  stripHeight: number
  safeLeft?: number
  safeRight?: number
}) {
  const left = safeLeft
  const right = viewportWidth - safeRight
  const bottom = viewportHeight - mobileNavHeight
  const top = bottom - stripHeight
  return {
    left,
    right,
    top,
    bottom,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  }
}

/** Desktop strip contract: span the operational shell between the rail and intel dock. */
// oxlint-disable-next-line react/only-export-components
export function desktopTrainingActivityRect({
  viewportWidth,
  railWidth,
  workspaceWidth = 0,
  intelWidth,
}: {
  viewportWidth: number
  railWidth: number
  workspaceWidth?: number
  intelWidth: number
}) {
  const left = Math.max(0, railWidth + Math.max(0, workspaceWidth))
  const right = Math.max(left, viewportWidth - Math.max(0, intelWidth))
  return {
    left,
    right,
    top: 0,
    bottom: 0,
    width: Math.max(0, right - left),
    height: 0,
  }
}

/** The global summary yields to the Models panel while its detailed queue is visible. */
// oxlint-disable-next-line react/only-export-components
export function shouldSuppressTrainingSummary(workspaceOpen: boolean, activePanel: string): boolean {
  return workspaceOpen && activePanel === 'models'
}

/** Returns the exact run that an activity action should open in Models. */
// oxlint-disable-next-line react/only-export-components
export function modelsRunTargetForActivityAction(action: TrainingActivityAction): string | null {
  return action.kind === 'open-run' ? action.jobId : null
}

function ActivityItem({
  job,
  onAction,
}: {
  job: TrainingJobViewModel
  onAction: (action: TrainingActivityAction) => void
}) {
  const pct = Math.round(job.stageProgress * 100)
  return (
    <article
      className="training-activity-bar__item flex min-w-[11rem] max-w-[16rem] flex-[1_1_11rem] cursor-pointer items-center gap-1.5 rounded-md border border-line/70 bg-panel-2/75 px-2 py-1.5"
      data-job-id={job.id}
      data-urgency={job.urgency}
      data-stage={job.stage}
      data-status={job.statusLabel.toLowerCase().replaceAll(' ', '-')}
      data-issue={job.issueTone ?? 'none'}
      data-mobile-priority={
        job.job.pendingCampaignEvent || job.issueTone === 'danger' || job.issueTone === 'warning'
          ? 'urgent'
          : 'standard'
      }
      title={
        job.issueLabel
          ? `${job.name} · ${job.issueLabel} · ${job.allocatedPf.toFixed(2)} PF/d`
          : `${job.name} · ${job.stageLabel} ${pct}% · ${job.etaLabel} · ${job.allocatedPf.toFixed(2)} PF/d`
      }
      onClick={(event) => {
        event.stopPropagation()
        onAction({ kind: 'open-run', label: 'View run', jobId: job.id })
      }}
    >
      <span className={`shrink-0 ${iconToneClass(job)}`}>
        <ActivityIcon job={job} />
      </span>
      <button
        type="button"
        className="min-w-0 flex-1 text-left"
        onClick={(event) => {
          event.stopPropagation()
          onAction({ kind: 'open-run', label: 'View run', jobId: job.id })
        }}
      >
        <span className="flex min-w-0 items-center justify-between gap-1">
          <span className="min-w-0 truncate text-[0.75rem] font-semibold text-bone">
            {job.name}
          </span>
          <StatusChip tone={chipTone(job.statusTone)}>{job.statusLabel}</StatusChip>
        </span>
        <div className="training-activity-bar__meter mt-1" data-mobile-detail="progress">
          <MeterBar
            label={`${job.stageLabel} ${pct}%`}
            value={job.stageProgress}
            detail={job.etaLabel}
            tone={meterTone(job.statusTone)}
            live={!job.job.failed && job.statusLabel !== 'Paused'}
          />
        </div>
      </button>
      <span className="sr-only">
        {job.issueLabel ? `${job.issueLabel}. ` : ''}
        {job.allocatedPf > 0 ? `${job.allocatedPf.toFixed(2)} PF/d.` : 'No PF/d.'}
      </span>
      <HudButton
        type="button"
        variant={job.primaryAction.kind === 'recover' ? 'primary' : 'secondary'}
        className="min-h-7 shrink-0 px-2 text-[0.6875rem]"
        data-action-kind={job.primaryAction.kind}
        aria-label={`${job.primaryAction.label} ${job.name}`}
        onClick={(event) => {
          event.stopPropagation()
          onAction(job.primaryAction)
        }}
      >
        {job.primaryAction.label}
      </HudButton>
    </article>
  )
}

/**
 * Persistent, compact model-work queue. It deliberately owns no simulation
 * state: the view model reads the canonical jobs and only delegates actions to
 * the same store methods used by the Models panel.
 */
export function TrainingActivityBar({
  onOpenModels,
  onOpenModelsRun,
}: {
  /** Optional shell handoff for generic Models navigation. */
  onOpenModels?: () => void
  /** Optional shell handoff for actions that must focus one exact run. */
  onOpenModelsRun?: (jobId: string) => void
} = {}) {
  const state = useGameStore((s) => s.state)
  const activePanel = useGameStore((s) => s.activePanel)
  const workspaceOpen = useGameStore((s) => s.leftRailOpen)
  const setPanel = useGameStore((s) => s.setPanel)
  const pauseTraining = useGameStore((s) => s.pauseTraining)
  const recoverFailedPostTrainFromCheckpoint = useGameStore(
    (s) => s.recoverFailedPostTrainFromCheckpoint,
  )
  const activity = useMemo(() => buildTrainingActivity(state), [state])
  const suppressSummary = shouldSuppressTrainingSummary(workspaceOpen, activePanel)
  const openCampaignDecision = useUiStore((s) => s.openCampaignDecision)
  const pendingDecision = activity.jobs.find((job) => job.job.pendingCampaignEvent)

  const openModels = () => {
    if (onOpenModels) {
      onOpenModels()
      return
    }
    setPanel('models')
  }

  const handleAction = (action: TrainingActivityAction) => {
    if (action.kind === 'decide') {
      openCampaignDecision(action.jobId)
      return
    }
    if (action.kind === 'resume') {
      pauseTraining(action.jobId, false)
      return
    }
    if (action.kind === 'recover') {
      recoverFailedPostTrainFromCheckpoint({
        jobId: action.jobId,
        checkpointId: action.checkpointId,
      })
      return
    }
    const targetJobId = modelsRunTargetForActivityAction(action)
    if (targetJobId && onOpenModelsRun) {
      onOpenModelsRun(targetJobId)
      return
    }
    openModels()
  }

  return (
    <aside
      className="training-activity-bar pointer-events-none absolute bottom-[var(--hud-ops)] px-2"
      data-job-count={activity.jobs.length}
      data-active-count={activity.activeCount}
      data-issue-count={activity.issueCount}
      data-ready-count={activity.readyCount}
      data-summary-suppressed={suppressSummary ? 'true' : 'false'}
      aria-label="Training activity"
    >
      <div
        className="training-activity-bar__surface hud-surface flex min-h-12 min-w-0 cursor-pointer flex-col gap-1.5 rounded-lg px-2.5 py-1.5"
        data-open-models="true"
        data-mobile-summary="training"
        onClick={openModels}
      >
        {pendingDecision?.job.pendingCampaignEvent ? (
          <button
            type="button"
            data-campaign-decision-prompt="true"
            onClick={(event) => {
              event.stopPropagation()
              openCampaignDecision(pendingDecision.id)
            }}
            className="pointer-events-auto flex min-h-11 w-full items-center justify-between gap-2 rounded-md border border-amber/50 bg-amber/15 px-2.5 text-left"
          >
            <span className="min-w-0">
              <span className="block font-mono text-[0.5625rem] uppercase tracking-[0.12em] text-amber">
                Decision due
              </span>
              <span className="block truncate text-[0.8125rem] font-semibold text-bone">
                {pendingDecision.name}: {pendingDecision.job.pendingCampaignEvent.title}
              </span>
            </span>
            <span className="shrink-0 rounded-md bg-amber px-2 py-1 text-[0.6875rem] font-semibold text-void">
              Decide
            </span>
          </button>
        ) : null}
        <div className="flex min-w-0 items-center gap-2">
        <div className="flex shrink-0 items-center gap-2 border-r border-line/60 pr-2.5">
          <Brain size="1rem" weight="duotone" className="text-train" aria-hidden />
          {activity.jobs.length > 0 ? (
            <div
              className={`training-activity-bar__summary hidden min-w-0 sm:block ${suppressSummary ? 'training-activity-bar__summary--suppressed' : ''}`}
              data-mobile-detail="secondary"
            >
              <p className="hud-eyebrow">Training activity</p>
              <p className="truncate text-[0.75rem] text-bone">{activity.summary}</p>
            </div>
          ) : (
            <span className={`text-[0.6875rem] font-medium text-muted ${suppressSummary ? 'training-activity-bar__summary--suppressed' : ''}`}>Idle</span>
          )}
          <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {activity.liveAnnouncement}
          </span>
        </div>

        <div
          className="training-activity-bar__list flex min-w-0 flex-1 flex-wrap content-start items-stretch gap-1.5 overflow-y-auto panel-scroll"
          data-empty={activity.jobs.length === 0 ? 'true' : 'false'}
          data-job-count={activity.jobs.length}
          aria-label="Training runs"
        >
          {activity.jobs.length > 0 ? (
            activity.jobs.map((job) => (
              <ActivityItem key={job.id} job={job} onAction={handleAction} />
            ))
          ) : (
            <div
              className="flex min-w-0 flex-1 items-center gap-2 px-2 text-[0.75rem] text-muted"
              aria-hidden="true"
            >
              <CheckCircle size="1rem" className="text-mint" aria-hidden />
            </div>
          )}
        </div>

        <HudButton
          type="button"
          variant="ghost"
          className="shrink-0 min-h-8 px-2 text-[0.6875rem] text-mint"
          onClick={(event) => {
            event.stopPropagation()
            openModels()
          }}
        >
          Models
        </HudButton>
        </div>
      </div>
    </aside>
  )
}
