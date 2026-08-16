import { getResearchNode } from '../../../sim/balance/research'
import { useGameStore } from '../../../store/gameStore'
import { HudButton } from './HudPrimitives'

type Props = {
  nodeId: string
  label?: string
  compact?: boolean
  className?: string
}

/** Navigates a locked control directly to its research method and centers it. */
export function ResearchUnlockLink({ nodeId, label, compact = false, className = '' }: Props) {
  const openResearchNode = useGameStore((store) => store.openResearchNode)
  const node = getResearchNode(nodeId)

  return (
    <HudButton
      type="button"
      variant="ghost"
      onClick={(event) => {
        event.stopPropagation()
        openResearchNode(nodeId)
      }}
      className={`${
        compact
          ? 'inline-flex min-h-11 items-center gap-1 border-transparent px-1 py-0 text-[0.6875rem] font-medium text-research hover:text-bone'
          : 'flex min-h-11 w-full items-center justify-between gap-2 border-research/35 bg-research/10 px-2.5 py-2 text-left text-[0.75rem] text-research transition hover:border-research/65 hover:bg-research/15 active:translate-y-px'
      } focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-research/60 ${className}`}
      aria-label={`Open ${node.name} in Research`}
    >
      <span>{label ?? `Research ${node.name}`}</span>
      <span aria-hidden="true">→</span>
    </HudButton>
  )
}
