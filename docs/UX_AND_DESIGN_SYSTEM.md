# UX & Design System — Arabic-First RTL

The product is judged first by how *clear* it feels to a non-accountant Arabic user.
This system is binding for all three apps (ERP, Rep PWA, Platform Console).

## 1. Language, direction, numerals

- Default document: `<html lang="ar" dir="rtl">`; English locale switches `lang="en" dir="ltr"` (layout fully mirrors).
- Typography: **IBM Plex Sans Arabic** (UI + print fallback *Tajawal*), Latin numerals set tabular for figures; font-feature `tnum` in tables/keypads.
- Numerals: Western digits default, Arabic-Indic optional per tenant (A-3); **never mix** in one value.
- Dates: Gregorian storage/computation; display `dd/MM/yyyy` tenant-format; Hijri optional display (OQ-6); relative times in Arabic ("قبل 5 دقائق").
- Currency/numbers/quantities formatted per tenant formats (D-016/D-026): `١٬٢٣٤٫٥٦` style grouping, 2-decimal SAR default, up to 6-decimal quantities.
- CSS: logical properties only (`ms-/me-/ps-/pe-/start/end`); icons with directionality (arrows, back/next) mirrored via `scale-x-[1]`/`-1` rules; numeric keypads LTR order *within* RTL layout.

## 2. Themes

Light + dark (`next-themes` class strategy, FOUC-free via inline script). Token system
(CSS custom properties): `--bg, --surface, --surface-2, --border, --text, --text-dim,
--primary, --success, --warning, --danger, --info` (+focus ring). Contrast ≥ WCAG AA in
both themes; status colors paired **always** with icon + Arabic label (never color-only).

## 3. Status vocabulary (single source of truth)

| Key | Arabic label | Icon | Meaning |
|-----|-------------|------|---------|
| draft | مسودة | PencilLine | non-final, no effects |
| posted | مُرحَّلة | CheckCircle2 | posted |
| sync.pending | بانتظار المزامنة | Clock | in outbox |
| sync.syncing | جارٍ المزامنة | RefreshCw (spin) | in flight |
| sync.synced | تمت المزامنة | CloudCheck | accepted |
| sync.rejected | مرفوضة | XCircle | fix & re-issue |
| sync.conflict | تعارض | AlertTriangle | resolution needed |
| tax.local_draft | مسودة محلية | FileEdit | not issued |
| tax.pending_report | بانتظار الإبلاغ | UploadCloud | issued, reporting due |
| tax.reported/ cleared | مُبلَّغة / مُقاصة | ShieldCheck | accepted by ZATCA |
| tax.rejected | مرفوضة ضريبياً | ShieldX | correction needed |
| settlement.exception | فرق قيد المعالجة | Scale | exception open |
| transfer.in_transit | بالطريق | Truck | dispatched |

(Exact Arabic strings live in the locale dictionaries; this table defines semantics.)

## 4. Component inventory (reusable library)

AppShell (sidebar RTL, role-aware nav, tenant switcher, user menu) · PageHeader ·
DataTable (sort/filter/paginate/saved views, sticky totals row, row-status chips) ·
Toolbar+Filters (date-range presets: اليوم/الأمس/هذا الأسبوع/هذا الشهر/مخصص) · StatusBadge ·
Money / MoneyInput / QtyInput (steppers honoring product unit) · Combobox (Arabic
search-normalized: unify أإآ، ة/ه، ى/ي) · ProductPicker (name/SKU/barcode, camera
scanner on PWA) · CustomerSelect (balance chip, credit warnings) · Dialog/ConfirmDialog
(destructive = typing confirmation when severe) · Drawer · Tabs · EmptyState ·
Loading/Skeleton · OfflineBanner · SyncDashboardWidget · NotificationCenter ·
PrintButton w/ copy selector · Keypad (POS) · AuditTrailList · ExceptionCard.

## 5. POS ergonomics (both POS surfaces)

- Keyboard-first: barcode/Enter add line, `+/-` qty, F2 customer, F4 discount (perm-gated), F9 payment, Ctrl+S save dialog; full Arabic on-screen keypad fallback (touch).
- Line grid shows price orig/actual, discount, free badge; totals panel Arabic-labeled (الإجمالي، الخصم، الضريبة، الصافي، المدفوع، المتبقي).
- Save dialog (INVOICING_AND_ZATCA §5): two large buttons — «حفظ وترحيل» (primary) / «حفظ مسودة» — with live validation summary and explicit blocks listed in Arabic.
- One-handed mobile layout for rep PWA: bottom action bar, big targets (≥48px), high-contrast outdoor mode.

## 6. Forms & errors

- Inline validation on blur; server errors mapped to fields; **actionable** Arabic
  messages with fix links (e.g., missing posting account → deep link to mappings screen).
- Configuration errors (INV-17) render as guided cards, not raw alerts.
- Destructive/financial actions always ConfirmDialog (post, reverse, settle, delete draft, purge).

## 7. States coverage

Every list/detail has: loading skeleton, empty (with primary action), error (retry),
offline (read-only badge + queued indicator), syncing, success feedback (toast + status
change), permission-denied (explains lacking permission name in Arabic).

## 8. Print & PDF

- Templates: thermal (80mm) + A5/A4; `dir="rtl"` embedded fonts (Plex Arabic/Tajawal
  subset) for PDF; totals table aligned for Arabic; QR per tax rules; **print date**
  vs document date fields; copy labels (نسخة العميل / نسخة الأرشيف); never print "فاتورة
  ضريبية" unless qualified (INVOICING_AND_ZATCA §8); drafts stamped «مسودة» watermark.

## 9. Accessibility & inclusive design

AA contrast, visible focus rings, full keyboard flows (incl. POS), `aria-live` for
totals/status changes, screen-reader-friendly Arabic labels, reduced-motion honoring,
touch targets ≥ 44–48px, text scaling safe to 200%.

## 10. Dashboards (role-appropriate)

Tenant owner: KPIs (sales, collections, receivables, exceptions) · Accountant: period
status, pending approvals, reconciliations alerts · Warehouse: low stock, in-transit,
expiry · Sales manager: rep board, overrides pending · Rep (PWA home): today sales,
sync status, custody snapshot, settlement shortcut · Platform: ops widgets (§1.4 console).
All figures clickable → filtered source lists (drill-down principle).
