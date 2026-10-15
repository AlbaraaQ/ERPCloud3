import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Providers } from "@/components/providers";
import { getLocale, getDict, dirOf } from "@/i18n";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "حِساب | منظومة المحاسبة السحابية",
    template: "%s | حِساب",
  },
  description:
    "منظومة محاسبية سحابية للمصانع وشركات التوزيع ومبيعات المندوبين — فواتير، مخزون، تصنيع، وتسويات.",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  const t = getDict(locale);
  return (
    <html lang={locale} dir={dirOf(locale)} suppressHydrationWarning>
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        <Providers>{children}</Providers>
        <span className="sr-only">{t.app.tagline}</span>
      </body>
    </html>
  );
}
