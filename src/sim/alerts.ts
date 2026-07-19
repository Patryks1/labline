import type { SimAlert, SimState } from './types'

export function pushAlert(
  state: SimState,
  severity: SimAlert['severity'],
  message: string,
  id?: string,
): SimState {
  const alert: SimAlert = {
    id: id ?? `a-${state.day}-${message.slice(0, 24)}`,
    day: state.day,
    severity,
    message,
  }
  return {
    ...state,
    alerts: [alert, ...state.alerts].slice(0, 40),
  }
}
