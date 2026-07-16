// filepath: src/providers.tsx
import type { ReactNode } from "react";
import { Theme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";

/**
 * Wraps the app in the Astryx Theme provider. The theme exposes the
 * CSS custom properties that power every Astryx component, including the
 * chat primitives used below.
 */
export function AppProviders({ children }: { children: ReactNode }) {
  return <Theme theme={neutralTheme}>{children}</Theme>;
}