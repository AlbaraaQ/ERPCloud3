import { redirect } from "next/navigation";
import { getSessionContext } from "@/modules/identity/auth";
import { getLocale, getDict } from "@/i18n";
import { LoginForm } from "./login-form";
import { Landmark, ShieldCheck, Boxes, Factory } from "lucide-react";

export const metadata = { title: "تسجيل الدخول" };
export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const ctx = await getSessionContext();
  if (ctx?.tenant) redirect("/dashboard");

  const locale = await getLocale();
  const t = getDict(locale);

  const features = [
    { icon: Landmark, text: t.app.tagline },
    { icon: ShieldCheck, text: "عزل كامل للبيانات + سجل تدقيق لا يقبل التعديل" },
    { icon: Boxes, text: "مخزون ومبيعات وتحصيلات وتسويات مندوبين" },
    { icon: Factory, text: "تصنيع وتكاليف إنتاج ومتتبع تشغيلات" },
  ];

  return (
    <main className="grid min-h-screen lg:grid-cols-2">
      {/* Form side */}
      <section className="flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-md">
          <div className="mb-8 flex items-center gap-3">
            <div className="grid h-12 w-12 place-items-center rounded-2xl bg-primary text-primary-foreground shadow-lg">
              <Landmark className="h-6 w-6" aria-hidden />
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight">{t.app.name}</h1>
              <p className="text-xs text-muted">{t.app.tagline}</p>
            </div>
          </div>

          <div className="card p-8">
            <h2 className="text-lg font-semibold">{t.login.title}</h2>
            <p className="mt-1 text-sm text-muted">{t.login.subtitle}</p>
            <LoginForm t={t} />
          </div>

          <p className="mt-6 text-center text-xs leading-relaxed text-muted">
            {t.login.footer}
          </p>
        </div>
      </section>

      {/* Brand side */}
      <aside className="relative hidden overflow-hidden bg-primary lg:block">
        <div
          aria-hidden
          className="absolute inset-0 opacity-[0.12]"
          style={{
            backgroundImage:
              "radial-gradient(circle at 20% 30%, white 1.5px, transparent 1.5px), radial-gradient(circle at 80% 70%, white 1.5px, transparent 1.5px)",
            backgroundSize: "48px 48px, 64px 64px",
          }}
        />
        <div className="relative flex h-full flex-col justify-center gap-8 px-14 text-primary-foreground">
          <h2 className="max-w-md text-3xl font-bold leading-snug">
            محاسبة صحيحة. مخزون دقيق.
            <br />
            تسويات بلا مفاجآت.
          </h2>
          <ul className="space-y-4">
            {features.map(({ icon: Icon, text }, i) => (
              <li key={i} className="flex items-center gap-4">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white/15 backdrop-blur">
                  <Icon className="h-5 w-5" aria-hidden />
                </span>
                <span className="text-sm leading-relaxed text-white/90">{text}</span>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-xs text-white/90">حِساب — المرحلة ١: الأساس التقني</p>
        </div>
      </aside>
    </main>
  );
}
