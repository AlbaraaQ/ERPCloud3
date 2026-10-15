import { redirect } from "next/navigation";
import { getSessionContext } from "@/modules/identity/auth";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const ctx = await getSessionContext();
  redirect(ctx?.tenant ? "/dashboard" : "/login");
}
