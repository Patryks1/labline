import {
  useLayoutEffect,
  useRef,
  type DetailsHTMLAttributes,
  type ReactNode,
} from "react";
import { modelsDesktopDefaultDisclosureOpen } from "./modelsResponsiveLayout";

export function ModelsDesktopDefaultDetails({
  children,
  ...props
}: DetailsHTMLAttributes<HTMLDetailsElement> & { children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.open = modelsDesktopDefaultDisclosureOpen();
  }, []);

  return (
    <details ref={ref} {...props}>
      {children}
    </details>
  );
}
