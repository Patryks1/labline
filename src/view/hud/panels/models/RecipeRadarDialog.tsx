import type { ReactNode } from "react";
import { ConsoleDialog } from "../../ui/ConsoleDialog";

export function RecipeRadarDialog({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children?: ReactNode;
}) {
  return (
    <ConsoleDialog
      open={open}
      titleId="recipe-spider-mix"
      eyebrow="Data recipe"
      title={title}
      description="Drag domains on the radar. Verify share and teachers stay on this mix."
      onClose={onClose}
      closeLabel="Close spider mix"
      maxWidthClass="max-w-5xl"
    >
      {children}
    </ConsoleDialog>
  );
}
