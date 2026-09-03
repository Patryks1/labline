import { describe, expect, it } from "vitest";
import { resetModelsUi, useModelsUi } from "./modelsUiStore";

describe("modelsUiStore", () => {
  it("starts on pipeline with empty selection and dialog", () => {
    resetModelsUi();
    const snap = useModelsUi.getState();
    expect(snap.tab).toBe("pipeline");
    expect(snap.selection).toBeNull();
    expect(snap.dialog).toBeNull();
  });

  it("transitions tab, selection, and dialog", () => {
    resetModelsUi();
    useModelsUi.getState().setTab("fleet");
    useModelsUi.getState().select({ kind: "checkpoint", id: "cp-kept" });
    useModelsUi.getState().openDialog({ kind: "evaluate", checkpointId: "cp-kept" });
    expect(useModelsUi.getState()).toMatchObject({
      tab: "fleet",
      selection: { kind: "checkpoint", id: "cp-kept" },
      dialog: { kind: "evaluate", checkpointId: "cp-kept" },
    });
    useModelsUi.getState().closeDialog();
    expect(useModelsUi.getState().dialog).toBeNull();
    useModelsUi.getState().select(null);
    expect(useModelsUi.getState().selection).toBeNull();
    resetModelsUi();
    expect(useModelsUi.getState().tab).toBe("pipeline");
  });
});
