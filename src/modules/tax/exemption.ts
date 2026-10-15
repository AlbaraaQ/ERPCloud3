/**
 * Saudi VAT exemption reason catalogue (D-012).
 *
 * Source of truth: the KSA business rules shipped with the official SDK
 * (Data/Rules/schematrons/20210819_ZATCA_E-invoice_Validation_Rules.xsl and the
 * SDK jar's 20210718 ruleset) plus the SDK sample documents:
 *   BR-KSA-CL-04 restricts TaxExemptionReasonCode to the 14 VATEX-SA-* codes;
 *   BR-KSA-CL-05 restricts TaxExemptionReason to the exact English texts below;
 *   samples pair them: Z + VATEX-SA-32 "Export of goods",
 *                      E + VATEX-SA-29-7 "Life insurance services mentioned in ...".
 * Category membership follows the KSA VAT treatment of each supply (E = exempt,
 * Z = zero-rated). Tenants pick a code; the text is NEVER free-form, so the
 * emitted document cannot violate the rule pair.
 *
 * Out-of-scope (O) supplies are not constrained by CL-04/CL-05: the SDK sample
 * (Out_Of_Scope_Simplified_Invoice.xml) uses VATEX-EU-O, the XML implementation
 * standard lists VATEX-SA-OOS with a taxpayer-supplied free text — both are
 * accepted here and the caller may pass a reason of its own.
 */

export type TaxCategoryCode = "S" | "Z" | "E" | "O";

export interface ExemptionReason {
  code: string;
  category: "Z" | "E";
  /** exact BR-KSA-CL-05 English text — emitted verbatim */
  text: string;
}

export const EXEMPTION_REASONS: readonly ExemptionReason[] = [
  {
    code: "VATEX-SA-29",
    category: "E",
    text: "Financial services mentioned in Article 29 of the VAT Regulations",
  },
  {
    code: "VATEX-SA-29-7",
    category: "E",
    text: "Life insurance services mentioned in Article 29 of the VAT Regulations",
  },
  {
    code: "VATEX-SA-30",
    category: "E",
    text: "Real estate transactions mentioned in Article 30 of the VAT Regulations",
  },
  { code: "VATEX-SA-32", category: "Z", text: "Export of goods" },
  { code: "VATEX-SA-33", category: "Z", text: "Export of services" },
  { code: "VATEX-SA-34-1", category: "Z", text: "The international transport of goods" },
  { code: "VATEX-SA-34-2", category: "Z", text: "International transport of passengers" },
  {
    code: "VATEX-SA-34-3",
    category: "Z",
    text: "Services directly connected and incidental to a Supply of international passenger transport",
  },
  { code: "VATEX-SA-34-4", category: "Z", text: "Supply of a qualifying means of transport" },
  {
    code: "VATEX-SA-34-5",
    category: "Z",
    text: "Any services relating to Goods or passenger transportation, as defined in article twenty five of these Regulations",
  },
  { code: "VATEX-SA-35", category: "Z", text: "Medicines and medical equipment" },
  { code: "VATEX-SA-36", category: "Z", text: "Qualifying metals" },
  { code: "VATEX-SA-EDU", category: "E", text: "Private education to citizen" },
  { code: "VATEX-SA-HEA", category: "E", text: "Private healthcare to citizen" },
];

/** Codes accepted for out-of-scope supplies (no BR-KSA-CL-04 constraint). */
export const OUT_OF_SCOPE_CODES = ["VATEX-EU-O", "VATEX-SA-OOS"] as const;

export function exemptionByCode(code: string): ExemptionReason | null {
  return EXEMPTION_REASONS.find((r) => r.code === code) ?? null;
}

export function exemptionCodesFor(category: "Z" | "E"): string[] {
  return EXEMPTION_REASONS.filter((r) => r.category === category).map((r) => r.code);
}

/**
 * Tenants configure one code per category:
 *   { zero: "VATEX-SA-32", exempt: "VATEX-SA-29-7", outOfScope: { code, reason? } }
 */
export interface ExemptionConfig {
  zero?: string;
  exempt?: string;
  outOfScope?: { code?: string; reason?: string };
}

export interface ResolvedExemption {
  code: string;
  reason: string | null;
  /** false for out-of-scope supplies, whose TaxCategory has no cbc:Percent */
  includePercent: boolean;
}

/**
 * Resolve the exemption that a document/line of `category` must carry.
 * Returns null for standard-rated supplies; throws a ConfigurationError-style
 * signal (null + code) when the tenant has not configured the required ruling —
 * the caller blocks issuance instead of guessing (INV-17).
 */
export function resolveExemption(
  config: ExemptionConfig | null | undefined,
  category: TaxCategoryCode,
): { ok: true; exemption: ResolvedExemption | null } | { ok: false; reason: string } {
  if (category === "S") return { ok: true, exemption: null };

  if (category === "O") {
    const code = config?.outOfScope?.code ?? OUT_OF_SCOPE_CODES[0];
    if (!(OUT_OF_SCOPE_CODES as readonly string[]).includes(code)) {
      return { ok: false, reason: `out_of_scope_code_unknown:${code}` };
    }
    const reason = config?.outOfScope?.reason?.trim() || null;
    if (reason && reason.length > 127) return { ok: false, reason: "exemption_reason_too_long" };
    return { ok: true, exemption: { code, reason, includePercent: false } };
  }

  const code = category === "Z" ? config?.zero : config?.exempt;
  if (!code) return { ok: false, reason: `exemption_code_missing:${category}` };
  const found = exemptionByCode(code);
  if (!found || found.category !== category) {
    return { ok: false, reason: `exemption_code_invalid:${category}:${code}` };
  }
  return { ok: true, exemption: { code: found.code, reason: found.text, includePercent: true } };
}
