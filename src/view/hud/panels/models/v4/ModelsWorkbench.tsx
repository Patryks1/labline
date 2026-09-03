import type { ReactNode } from "react";
import { useGameStore } from "../../../../../store/gameStore";
import { HudButton, PanelScaffold } from "../../../ui/HudPrimitives";
import { SegmentedTabs } from "../../../ui/kit";
import { MonoStat } from "../ui/MonoStat";
import { selectWorkbenchStats } from "../viewModels/selectors";
import { ModelsDialogs } from "./dialogs/ModelsDialogs";
import { FleetBoard } from "./fleet/FleetBoard";
import { RouterBuilderDialog } from "./fleet/RouterBuilderDialog";
import { SunsetDialog } from "./fleet/SunsetDialog";
import { GymsBoard } from "./gyms/GymsBoard";
import { IncidentModalHost } from "./IncidentModal";
import { Inspector } from "./Inspector";
import { PipelineBoard } from "./PipelineBoard";
import { useModelsUi, type ModelsTab } from "./modelsUiStore";
import "./models-v4.css";

const TABS: { id: ModelsTab; label: string; panelId: string }[] = [
  { id: "pipeline", label: "Pipeline", panelId: "models-v4-pipeline" },
  { id: "fleet", label: "Fleet", panelId: "models-v4-fleet" },
  { id: "gyms", label: "Gyms", panelId: "models-v4-gyms" },
];

export function ModelsWorkbench({
  fleet,
  gyms,
  dialogs,
}: {
  fleet?: ReactNode;
  gyms?: ReactNode;
  dialogs?: ReactNode;
}) {
  const state = useGameStore((store) => store.state);
  const stats = selectWorkbenchStats(state);
  const tab = useModelsUi((store) => store.tab);
  const setTab = useModelsUi((store) => store.setTab);
  const openDialog = useModelsUi((store) => store.openDialog);
  const closeDialog = useModelsUi((store) => store.closeDialog);
  const select = useModelsUi((store) => store.select);
  const selection = useModelsUi((store) => store.selection);
  const dialog = useModelsUi((store) => store.dialog);
  const selectedEndpointId = selection?.kind === "endpoint" ? selection.id : undefined;
  const selectedGymId = selection?.kind === "gym" ? selection.id : undefined;

  return (
    <PanelScaffold
      title="Models"
      className="models-v4-panel"
      actions={
        <HudButton
          variant="primary"
          className="min-h-11"
          data-action="models-new-model"
          onClick={() => openDialog({ kind: "design" })}
        >
          New model
        </HudButton>
      }
    >
      <div className="models-v4-workbench" data-models-v4="true">
        <div className="models-v4-layout">
          <div className="models-v4-stats">
            <MonoStat
              label="Runs in flight"
              value={String(stats.runsInFlight)}
              hint={`${stats.trainingPf.toFixed(1)} PF pool`}
            />
            <MonoStat label="Checkpoints kept" value={String(stats.checkpointsKept)} />
            <MonoStat label="Endpoints live" value={String(stats.endpointsLive)} />
          </div>
          <div className="models-v4-tabs">
            <SegmentedTabs
              ariaLabel="Models views"
              idPrefix="models-v4-tabs"
              active={tab}
              onChange={(id) => setTab(id as ModelsTab)}
              items={TABS}
            />
          </div>
          <div className="models-v4-body">
            <div className="models-v4-board min-w-0 panel-scroll">
              {tab === "pipeline" ? (
                <div id="models-v4-pipeline" role="tabpanel">
                  <PipelineBoard />
                </div>
              ) : null}
              {tab === "fleet" ? (
                <div id="models-v4-fleet" role="tabpanel">
                  {fleet ?? (
                    <FleetBoard
                      selectedId={selectedEndpointId}
                      onSelect={(id) => select({ kind: "endpoint", id })}
                      onOpenRouter={(id) => openDialog({ kind: "router", endpointId: id })}
                      onOpenSunset={(id) => openDialog({ kind: "sunset", endpointId: id })}
                    />
                  )}
                </div>
              ) : null}
              {tab === "gyms" ? (
                <div id="models-v4-gyms" role="tabpanel">
                  {gyms ?? (
                    <GymsBoard
                      selectedId={selectedGymId}
                      onSelect={(id) => select({ kind: "gym", id })}
                    />
                  )}
                </div>
              ) : null}
            </div>
          </div>
          <Inspector />
        </div>
        {dialogs ?? (
          <>
            <ModelsDialogs dialog={dialog} onClose={closeDialog} />
            <RouterBuilderDialog
              open={dialog?.kind === "router"}
              onClose={closeDialog}
              endpointId={dialog?.kind === "router" ? dialog.endpointId : undefined}
            />
            <SunsetDialog
              open={dialog?.kind === "sunset"}
              onClose={closeDialog}
              endpointId={dialog?.kind === "sunset" ? dialog.endpointId : ""}
            />
          </>
        )}
        <IncidentModalHost />
      </div>
    </PanelScaffold>
  );
}

export default ModelsWorkbench;
