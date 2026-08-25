import type { ResearchLead, ResearchPod, ResearchPodFocus } from '../types'

export interface ResearchPodTemplate {
  id: string
  podName: string
  focus: ResearchPodFocus
  lead: ResearchLead
  openCost: number
  requiresResearch?: string
  starter?: boolean
}

/**
 * Named teams keep pod expansion legible: opening a pod recruits its lead,
 * while researchers, engineers, and data staff still come from the finite HQ
 * headcount ledger. Only Foundations starts open; later pods unlock from
 * org and data research so the queue stays one team until the tree earns more.
 */
export const RESEARCH_POD_TEMPLATES: readonly ResearchPodTemplate[] = [
  {
    id: 'pod-foundations',
    podName: 'Foundations Pod',
    focus: 'scaling',
    starter: true,
    openCost: 0,
    lead: {
      id: 'lead-mira-chen',
      name: 'Dr. Mira Chen',
      skills: { algorithms: 0.82, systems: 0.66, dataEvals: 0.72, leadership: 0.78 },
      specialties: { reasoning: 0.88, math: 0.8, science: 0.72 },
      traits: ['scaling intuition', 'patient mentor'],
      reputation: 62,
      morale: 78,
      salaryPerDay: 3_400,
    },
  },
  {
    id: 'pod-systems',
    podName: 'Systems Pod',
    focus: 'systems',
    openCost: 0,
    requiresResearch: 'org_talent',
    lead: {
      id: 'lead-jonah-reyes',
      name: 'Jonah Reyes',
      skills: { algorithms: 0.68, systems: 0.9, dataEvals: 0.7, leadership: 0.74 },
      specialties: { code: 0.86, tools: 0.84, reasoning: 0.65 },
      traits: ['systems optimizer', 'fast integrator'],
      reputation: 59,
      morale: 80,
      salaryPerDay: 3_100,
    },
  },
  {
    id: 'pod-applied',
    podName: 'Applied Intelligence Pod',
    focus: 'exploration',
    openCost: 750_000,
    requiresResearch: 'org_labs',
    lead: {
      id: 'lead-ada-okafor',
      name: 'Dr. Ada Okafor',
      skills: { algorithms: 0.76, systems: 0.7, dataEvals: 0.79, leadership: 0.73 },
      specialties: { language: 0.82, tools: 0.78, reasoning: 0.74 },
      traits: ['rapid prototyper', 'cross-domain thinker'],
      reputation: 55,
      morale: 82,
      salaryPerDay: 3_250,
    },
  },
  {
    id: 'pod-evals',
    podName: 'Reliability & Evals Pod',
    focus: 'evals',
    openCost: 2_500_000,
    requiresResearch: 'data_clean',
    lead: {
      id: 'lead-elena-vasquez',
      name: 'Elena Vasquez',
      skills: { algorithms: 0.69, systems: 0.72, dataEvals: 0.93, leadership: 0.8 },
      specialties: { reasoning: 0.9, science: 0.78, language: 0.74 },
      traits: ['red-team discipline', 'measurement purist'],
      reputation: 68,
      morale: 76,
      salaryPerDay: 4_200,
    },
  },
  {
    id: 'pod-frontier',
    podName: 'Frontier Systems Pod',
    focus: 'systems',
    openCost: 7_500_000,
    requiresResearch: 'opt_pipeline',
    lead: {
      id: 'lead-soren-ito',
      name: 'Soren Ito',
      skills: { algorithms: 0.84, systems: 0.94, dataEvals: 0.68, leadership: 0.83 },
      specialties: { code: 0.91, math: 0.82, tools: 0.76 },
      traits: ['cluster architect', 'frontier operator'],
      reputation: 74,
      morale: 74,
      salaryPerDay: 5_600,
    },
  },
] as const

export function researchPodFromTemplate(template: ResearchPodTemplate): ResearchPod {
  return {
    id: template.id,
    name: template.podName,
    leadId: template.lead.id,
    focus: template.focus,
    researchers: 0,
    engineers: 0,
    dataStaff: 0,
    assignmentId: null,
  }
}

export function starterResearchPodTemplates(): ResearchPodTemplate[] {
  return RESEARCH_POD_TEMPLATES.filter((template) => template.starter)
}
