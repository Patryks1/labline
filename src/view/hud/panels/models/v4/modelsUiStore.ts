import { create } from "zustand";
import type { ModelsDialog, ModelsSelection } from "../viewModels/types";

export type ModelsTab = "pipeline" | "fleet" | "gyms";

export interface ModelsUiStore {
  tab: ModelsTab;
  selection: ModelsSelection;
  dialog: ModelsDialog;
  setTab: (tab: ModelsTab) => void;
  select: (selection: ModelsSelection) => void;
  openDialog: (dialog: NonNullable<ModelsDialog>) => void;
  closeDialog: () => void;
}

const INITIAL: Pick<ModelsUiStore, "tab" | "selection" | "dialog"> = {
  tab: "pipeline",
  selection: null,
  dialog: null,
};

/** Panel-local UI state. WS-I and WS-J import `useModelsUi`. Keep this API stable. */
export const useModelsUi = create<ModelsUiStore>()((set) => ({
  ...INITIAL,
  setTab: (tab) => set({ tab }),
  select: (selection) => set({ selection }),
  openDialog: (dialog) => set({ dialog }),
  closeDialog: () => set({ dialog: null }),
}));

export function resetModelsUi(): void {
  useModelsUi.setState({ ...INITIAL });
}
