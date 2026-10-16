/**
 * `npm run env:check` — fail *early* and *clearly* when the environment is not usable.
 *
 * A missing encryption key or an unquoted password with a `#` in it produces a login screen
 * that returns 200 and a backup command that dies deep inside a pg driver error. Both were real
 * defects. This check states the problem in one line, in Arabic and English, before anything
 * else runs — and it is also what `db:migrate` / `db:seed` / the login probe rely on.
 *
 * Exit 0 = usable, exit 1 = the operator must fix `.env` first.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const ENV_PATH = path.join(ROOT, ".env");

interface Problem {
  ar: string;
  en: string;
}
const problems: Problem[] = [];
const notes: string[] = [];

if (!existsSync(ENV_PATH)) {
  problems.push({
    ar: "ملف .env غير موجود — شغّل: npm run env:setup",
    en: ".env is missing — run: npm run env:setup",
  });
} else {
  const text = readFileSync(ENV_PATH, "utf8");
  const line = (key: string) => new RegExp(`^${key}=(.*)$`, "m").exec(text)?.[1] ?? "";

  const value = (key: string) => {
    const raw = line(key).trim();
    const quoted = /^".*"$/.test(raw) || /^'.*'$/.test(raw);
    return { raw, clean: quoted ? raw.slice(1, -1) : raw.split("#")[0]!.trim(), quoted };
  };

  const db = value("DATABASE_URL");
  if (!db.clean) {
    problems.push({ ar: "DATABASE_URL فارغ — لا يمكن الاتصال بقاعدة البيانات", en: "DATABASE_URL is empty" });
  } else if (!/^postgres(ql)?:\/\//.test(db.clean)) {
    problems.push({ ar: "DATABASE_URL ليس رابط PostgreSQL صالحًا", en: "DATABASE_URL is not a postgres:// URL" });
  }

  const key = value("HISAB_ENCRYPTION_KEY");
  const keyBytes = (() => {
    const v = key.clean;
    if (/^[0-9a-fA-F]{64}$/.test(v)) return 32;
    try {
      return Buffer.from(v, "base64").length;
    } catch {
      return 0;
    }
  })();
  if (!key.clean) {
    problems.push({
      ar: "HISAB_ENCRYPTION_KEY فارغ — لا نسخ احتياطية مُشفَّرة ولا مفاتيح ZATCA قابلة للفكّ",
      en: "HISAB_ENCRYPTION_KEY is empty — no encrypted backup or ZATCA key can be read",
    });
  } else if (keyBytes !== 32) {
    problems.push({
      ar: `HISAB_ENCRYPTION_KEY يجب أن يكون 32 بايت (base64 أو 64 خانة سداسية عشرية) — الطول الحالي ${keyBytes}`,
      en: `HISAB_ENCRYPTION_KEY must be 32 bytes (base64 or 64 hex) — got ${keyBytes}`,
    });
  }

  // The defect this check was written for: dotenv ends a bare value at `#`.
  for (const name of ["SEED_DEMO_PASSWORD", "SEED_BOOTSTRAP_PASSWORD"]) {
    const raw = line(name);
    if (!raw) continue;
    if (!/^["']/.test(raw.trim()) && raw.includes("#")) {
      problems.push({
        ar: `${name} يحتوي # بدون علامات تنصيص — سيُقتطع نصفه ويفشل تسجيل الدخول`,
        en: `${name} contains # without quotes — dotenv truncates it and login fails`,
      });
    }
  }

  const worker = value("ENABLE_WORKER").clean;
  if (worker && !["true", "false"].includes(worker)) {
    problems.push({ ar: "ENABLE_WORKER يجب أن يكون true أو false", en: "ENABLE_WORKER must be true or false" });
  }

  const origins = value("HISAB_ALLOWED_ORIGINS").clean;
  if (origins) notes.push(`server actions accepted from: ${origins}`);
  notes.push(
    `worker ${worker === "true" ? "enabled" : "disabled (jobs run via npm scripts)"} · database ${db.clean.replace(/\/\/[^@]*@/, "//***@")}`,
  );
}

for (const problem of problems) {
  console.error(`✗ ${problem.ar}\n  ${problem.en}`);
}
if (problems.length === 0) {
  console.log("✓ .env looks usable / ملف البيئة سليم");
  for (const note of notes) console.log(`  ${note}`);
}
process.exit(problems.length === 0 ? 0 : 1);
