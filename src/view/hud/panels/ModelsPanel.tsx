import { ModelsWorkbench } from "./models/v4/ModelsWorkbench";

export interface ModelsPanelProps {
  /** Unused: V4 selection lives in `modelsUiStore`. Kept for LeftRail compat. */
  focusJobId?: string | null;
  onFocusHandled?: () => void;
}

/** Models workspace. Pipeline / Fleet / Gyms plus design dialogs. */
export function ModelsPanel(_props: ModelsPanelProps = {}) {
  return <ModelsWorkbench />;
}

export default ModelsPanel;
