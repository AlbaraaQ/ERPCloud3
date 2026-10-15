"use client";

import { ThemeProvider } from "next-themes";
import type { ReactNode } from "react";

/** App providers — theme (class strategy, system-aware, no flash). */
export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      {children}
    </ThemeProvider>
  );
}
