import {
  useLayoutEffect,
  useRef,
  type DetailsHTMLAttributes,
  type ReactNode,
} from "react";
import { hudDesktopDefaultDisclosureOpen } from "./hudDesktopDisclosure";

export function HudDesktopDefaultDetails({
  children,
  ...props
}: DetailsHTMLAttributes<HTMLDetailsElement> & { children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.open = hudDesktopDefaultDisclosureOpen();
  }, []);

  return (
    <details {...props} ref={ref}>
      {children}
    </details>
  );
}
