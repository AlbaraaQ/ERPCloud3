-- ============================================================================
-- Hisab ERP — Row-Level Security & security-definer functions (D-002, D-018)
-- Idempotent: safe to re-run. Apply AFTER `drizzle-kit push`.
-- ============================================================================

create extension if not exists pgcrypto;

-- --------------------------------------------------------------------------
-- Helpers
-- --------------------------------------------------------------------------
create or replace function public.app_tenant_id() returns uuid
language sql stable as $$
  select nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

-- --------------------------------------------------------------------------
-- Tenant tables under RLS (layer 2 of tenant isolation — defense in depth).
-- sessions / permissions / platform_users are infrastructure & platform-owned
-- (sessions: accessed only via token hash; permissions: global catalog).
-- --------------------------------------------------------------------------
do $$
declare
  t text;
  tenant_tables text[] := array[
    'users', 'employees', 'roles', 'role_permissions', 'user_roles',
    'companies', 'branches', 'document_counters', 'notifications',
    'audit_log', 'tenants'
  ];
begin
  foreach t in array tenant_tables loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
  end loop;
end $$;

-- tenants: a session sees only its own tenant row
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='tenants' and policyname='tenants_isolation') then
    create policy tenants_isolation on public.tenants
      using (id = public.app_tenant_id())
      with check (id = public.app_tenant_id());
  end if;
end $$;

-- tenant_id-keyed tables (uniform policy)
do $$
declare
  t text;
  keyed text[] := array[
    'users', 'employees', 'roles', 'user_roles',
    'companies', 'branches', 'document_counters', 'notifications'
  ];
begin
  foreach t in array keyed loop
    if not exists (select 1 from pg_policies where schemaname='public' and tablename=t and policyname='tenant_isolation') then
      execute format(
        'create policy tenant_isolation on public.%I using (tenant_id = public.app_tenant_id()) with check (tenant_id = public.app_tenant_id())',
        t
      );
    end if;
  end loop;
end $$;

-- role_permissions has no tenant_id: visible iff the parent role is in-tenant
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='role_permissions' and policyname='tenant_isolation') then
    create policy tenant_isolation on public.role_permissions
      using (exists (select 1 from public.roles r where r.id = role_id and r.tenant_id = public.app_tenant_id()))
      with check (exists (select 1 from public.roles r where r.id = role_id and r.tenant_id = public.app_tenant_id()));
  end if;
end $$;

-- audit_log: readable only within tenant; NULL-tenant rows (e.g. failed logins)
-- are invisible to tenants (platform reads via privileged role).
-- Inserts happen via write_audit (security definer), so WITH TRUE is fine.
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='audit_log' and policyname='tenant_isolation') then
    create policy tenant_isolation on public.audit_log
      using (tenant_id = public.app_tenant_id())
      with check (true);
  end if;
end $$;

-- --------------------------------------------------------------------------
-- Pre-auth login lookups (SECURITY DEFINER): needed because RLS would hide
-- user rows before a session exists. Returns only what authentication needs.
-- --------------------------------------------------------------------------
create or replace function public.user_login_lookup(p_email text)
returns table (
  user_id uuid,
  tenant_id uuid,
  tenant_status text,
  tenant_name text,
  password_hash text,
  name text,
  is_owner boolean,
  status text
)
language sql stable security definer
set search_path = public
as $$
  select u.id, u.tenant_id, t.status::text, t.name, u.password_hash, u.name, u.is_owner, u.status::text
  from public.users u
  join public.tenants t on t.id = u.tenant_id
  where lower(u.email) = lower(p_email)
  order by u.is_owner desc, u.created_at asc
  limit 1;
$$;

create or replace function public.platform_login_lookup(p_email text)
returns table (platform_user_id uuid, password_hash text, name text, role text, status text)
language sql stable security definer
set search_path = public
as $$
  select p.id, p.password_hash, p.name, p.role::text, p.status::text
  from public.platform_users p
  where lower(p.email) = lower(p_email)
  limit 1;
$$;

-- --------------------------------------------------------------------------
-- write_audit: append-only audit with per-tenant hash chain (tamper evidence).
-- SECURITY DEFINER so audit inserts always succeed while reads stay RLS-scoped.
-- --------------------------------------------------------------------------
create or replace function public.write_audit(
  p_id uuid,
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_actor_platform_user_id uuid,
  p_actor_label text,
  p_action text,
  p_entity text,
  p_entity_id text,
  p_before jsonb,
  p_after jsonb,
  p_ip text,
  p_user_agent text
) returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_prev text;
  v_hash text;
begin
  -- serialize chain writes per tenant (advisory lock, xact-scoped)
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_tenant_id::text, 'platform'), 0));

  select a.hash into v_prev
  from public.audit_log a
  where a.tenant_id is not distinct from p_tenant_id
  order by a.at desc, a.id desc
  limit 1;

  v_hash := encode(digest(
    coalesce(v_prev, '') || '|' ||
    coalesce(p_tenant_id::text, '') || '|' ||
    coalesce(p_actor_label, '') || '|' || p_action || '|' ||
    coalesce(p_entity, '') || '|' || coalesce(p_entity_id, '') || '|' ||
    coalesce(p_after::text, '') || '|' || clock_timestamp()::text,
    'sha256'
  ), 'hex');

  insert into public.audit_log (
    id, tenant_id, actor_user_id, actor_platform_user_id, actor_label,
    action, entity, entity_id, "before", "after", ip, user_agent, prev_hash, hash
  ) values (
    p_id, p_tenant_id, p_actor_user_id, p_actor_platform_user_id, p_actor_label,
    p_action, p_entity, p_entity_id, p_before, p_after, p_ip, p_user_agent, v_prev, v_hash
  );

  return p_id;
end;
$$;

-- --------------------------------------------------------------------------
-- Auditing the audit: no UPDATE/DELETE on audit_log for the app role.
-- (Owner/superuser can still maintain; production app role gets the revoke.)
-- --------------------------------------------------------------------------
revoke update, delete on public.audit_log from public;

-- --------------------------------------------------------------------------
-- PRODUCTION ONLY (documented requirement — SECURITY_AND_TENANCY §2):
-- create a restricted application role subject to RLS; the sandbox connects
-- as superuser, so tests prove policies with a dedicated test role instead.
--
--   create role hisab_app login password '...' nobypassrls;
--   grant connect on database app_db to hisab_app;
--   grant usage on schema public to hisab_app;
--   grant select, insert, update, delete on all tables in schema public to hisab_app;
--   grant execute on function public.app_tenant_id, public.user_login_lookup(text),
--     public.platform_login_lookup(text), public.write_audit(uuid,uuid,uuid,uuid,text,text,text,text,jsonb,jsonb,text,text)
--     to hisab_app;
-- ============================================================================

-- ========================================================================
-- Phase 2: accounting/inventory RLS + invariant triggers (merged; canonical)
-- ========================================================================
-- ============================================================================
-- Hisab ERP — Phase 2: RLS for accounting/inventory tables + invariant triggers
-- (INV-01 balanced journals, INV-03/04 immutability, closed-period guard,
-- append-only stock ledger). Idempotent. Apply AFTER `drizzle-kit push`.
-- ============================================================================

-- RLS on tenant-keyed tables -----------------------------------------------
do $$
begin
  perform public.app_tenant_id();
  -- nothing; just ensures helper exists from rls.sql
end $$;

do $$
declare
  t text;
  keyed text[] := array[
    'accounts', 'posting_mappings', 'fiscal_years', 'fiscal_periods',
    'journal_entries', 'journal_lines',
    'categories', 'brands', 'units', 'products', 'product_units',
    'warehouses', 'stock_lots', 'stock_ledger', 'stock_balances',
    'transfers', 'transfer_lines',
    'customers', 'customer_prices', 'suppliers',
    'sales_invoices', 'sales_invoice_lines',
    'receipts', 'receipt_lines', 'allocations',
    'treasury_accounts', 'expenses',
    'purchase_invoices', 'purchase_invoice_lines',
    'supplier_payments', 'supplier_allocations',
    'representatives', 'devices', 'idempotency_keys', 'sync_cursors',
    'settlements', 'settlement_lines', 'settlement_exceptions',
    'boms', 'bom_lines', 'production_orders', 'production_consumptions',
    'production_outputs', 'production_cost_components',
    'tax_configs', 'zatca_certificates', 'invoice_chains', 'invoice_submissions'
  ];
begin
  foreach t in array keyed loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    if not exists (select 1 from pg_policies where schemaname='public' and tablename=t and policyname='tenant_isolation') then
      execute format(
        'create policy tenant_isolation on public.%I using (tenant_id = public.app_tenant_id()) with check (tenant_id = public.app_tenant_id())',
        t
      );
    end if;
  end loop;
end $$;

-- INV-01: posted journal must balance (HALF_UP 2dp per D-003) ---------------
create or replace function public.assert_journal_postable()
returns trigger
language plpgsql as $$
declare
  v_dr numeric;
  v_cr numeric;
  v_period_status text;
begin
  if new.status <> 'posted' then
    return new;
  end if;

  select coalesce(sum(round(debit::numeric, 2)), 0), coalesce(sum(round(credit::numeric, 2)), 0)
    into v_dr, v_cr
  from public.journal_lines
  where entry_id = new.id;

  if v_dr = 0 and v_cr = 0 then
    raise exception 'INV-01: posted journal % has no lines', new.id
      using errcode = 'restrict_violation';
  end if;
  if v_dr <> v_cr then
    raise exception 'INV-01: journal % not balanced: dr=% cr=%', new.id, v_dr, v_cr
      using errcode = 'restrict_violation';
  end if;

  -- no posting into a closed period (ACCOUNTING_POLICY §2)
  if new.period_id is not null then
    select status into v_period_status from public.fiscal_periods where id = new.period_id;
    if v_period_status is distinct from 'open' then
      raise exception 'period % is not open for posting', new.period_id
        using errcode = 'restrict_violation';
    end if;
  end if;

  if new.entry_no is null then
    raise exception 'posted journal requires an entry number (assigned at posting time)'
      using errcode = 'restrict_violation';
  end if;

  return new;
end $$;

drop trigger if exists trg_journal_postable on public.journal_entries;
create trigger trg_journal_postable
  before insert or update on public.journal_entries
  for each row execute function public.assert_journal_postable();

-- INV-03: posted journals immutable (no update/delete) -----------------------
create or replace function public.block_posted_journal_mutation()
returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'posted' then
      raise exception 'INV-03: posted journals cannot be deleted'; end if;
    return old;
  else
    if old.status = 'posted' then
      raise exception 'INV-03: posted journals are immutable';
    end if;
    return new;
  end if;
end $$;

drop trigger if exists trg_journal_immutable on public.journal_entries;
create trigger trg_journal_immutable
  before update or delete on public.journal_entries
  for each row execute function public.block_posted_journal_mutation();

-- Lines of a posted entry are immutable too ----------------------------------
create or replace function public.block_posted_lines_mutation()
returns trigger
language plpgsql as $$
declare
  v_status text;
begin
  if tg_op = 'DELETE' then
    select status into v_status from public.journal_entries where id = old.entry_id;
    if v_status = 'posted' then
      raise exception 'INV-03: lines of a posted journal are immutable'; end if;
    return old;
  else
    select status into v_status from public.journal_entries where id = new.entry_id;
    -- allow inserts while entry is a draft; updates/deletes blocked once posted
    if v_status = 'posted' and tg_op <> 'INSERT' then
      raise exception 'INV-03: lines of a posted journal are immutable'; end if;
    if v_status = 'posted' and tg_op = 'INSERT' then
      raise exception 'INV-03: cannot add lines to a posted journal'; end if;
    return new;
  end if;
end $$;

drop trigger if exists trg_journal_lines_immutable on public.journal_lines;
create trigger trg_journal_lines_immutable
  before insert or update or delete on public.journal_lines
  for each row execute function public.block_posted_lines_mutation();

-- Stock ledger is append-only (INV-05/D-008); corrections are new rows -------
create or replace function public.block_ledger_mutation()
returns trigger
language plpgsql as $$
begin
  raise exception 'INV-05: stock_ledger is append-only';
end $$;

drop trigger if exists trg_stock_ledger_immutable on public.stock_ledger;
create trigger trg_stock_ledger_immutable
  before update or delete on public.stock_ledger
  for each row execute function public.block_ledger_mutation();

-- Transfer line sanity: received never exceeds dispatched (INV-07) -----------
create or replace function public.check_transfer_line_qty()
returns trigger
language plpgsql as $$
begin
  if new.qty_received < 0 or new.qty_received > new.qty_dispatched then
    raise exception 'INV-07: qty_received (%) must be between 0 and qty_dispatched (%)',
      new.qty_received, new.qty_dispatched;
  end if;
  return new;
end $$;

drop trigger if exists trg_transfer_line_qty on public.transfer_lines;
create trigger trg_transfer_line_qty
  before insert or update on public.transfer_lines
  for each row execute function public.check_transfer_line_qty();

-- --------------------------------------------------------------------------
-- Phase 3: posted sales/purchase invoices are FULLY immutable (INV-03/11).
-- Sums paid/returned are derived from allocations & return documents —
-- never stored back onto the posted document.
-- --------------------------------------------------------------------------
create or replace function public.check_sales_invoice_mutable()
returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.business_status = 'posted' then
      raise exception 'INV-03: posted invoice cannot be deleted'; end if;
    return old;
  end if;
  if old.business_status = 'posted' then
    -- Orthogonal tax-dimension transitions are allowed (IZ §3/§4):
    -- the ONLY column that may change on a posted invoice is tax_status.
    -- Every other column must remain bit-identical.
    if (new.id, new.tenant_id, new.invoice_no, new.invoice_type,
        new.original_invoice_id, new.customer_id, new.warehouse_id,
        new.business_date, new.due_date, new.is_credit, new.business_status,
        new.inventory_status, new.accounting_status, new.subtotal,
        new.discount_total, new.vat_total, new.total, new.paid_total,
        new.salesperson_user_id, new.client_op_id, new.posted_at,
        new.posted_by, new.created_by, new.created_at)
      is distinct from
       (old.id, old.tenant_id, old.invoice_no, old.invoice_type,
        old.original_invoice_id, old.customer_id, old.warehouse_id,
        old.business_date, old.due_date, old.is_credit, old.business_status,
        old.inventory_status, old.accounting_status, old.subtotal,
        old.discount_total, old.vat_total, old.total, old.paid_total,
        old.salesperson_user_id, old.client_op_id, old.posted_at,
        old.posted_by, old.created_by, old.created_at)
    then
      raise exception 'INV-03: posted sales invoice is immutable (only tax_status may transition)';
    end if;
  end if;
  return new;
end $$;

create or replace function public.check_sales_line_mutable()
returns trigger
language plpgsql as $$
declare
  p_status text;
begin
  select business_status into p_status from public.sales_invoices
  where id = coalesce(new.invoice_id, old.invoice_id);
  if p_status = 'posted' then
    raise exception 'INV-03: lines of a posted invoice are immutable'; end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

drop trigger if exists trg_sales_invoices_immutable on public.sales_invoices;
create trigger trg_sales_invoices_immutable
  before update or delete on public.sales_invoices
  for each row execute function public.check_sales_invoice_mutable();

drop trigger if exists trg_sales_invoice_lines_immutable on public.sales_invoice_lines;
create trigger trg_sales_invoice_lines_immutable
  before insert or update or delete on public.sales_invoice_lines
  for each row execute function public.check_sales_line_mutable();

-- purchase invoices: header column is `status`; same immutability once posted
create or replace function public.check_purchase_invoice_mutable()
returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'posted' then
      raise exception 'INV-03: posted purchase invoice cannot be deleted'; end if;
    return old;
  end if;
  if old.status = 'posted' then
    raise exception 'INV-03: posted purchase invoice is immutable (use return documents)';
  end if;
  return new;
end $$;

drop trigger if exists trg_purchase_invoices_immutable on public.purchase_invoices;
create trigger trg_purchase_invoices_immutable
  before update or delete on public.purchase_invoices
  for each row execute function public.check_purchase_invoice_mutable();

-- settlements: closed settlements immutable (D-022); adjustments are new docs
create or replace function public.check_settlement_mutable()
returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'closed' then
      raise exception 'INV-03: closed settlements are immutable'; end if;
    return old;
  end if;
  if old.status = 'closed' then
    raise exception 'INV-03: closed settlements are immutable (authorized adjustment/reversal docs only)';
  end if;
  return new;
end $$;

drop trigger if exists trg_settlements_immutable on public.settlements;
create trigger trg_settlements_immutable
  before update or delete on public.settlements
  for each row execute function public.check_settlement_mutable();

-- completed production orders are final; edits happen via new orders (INV-03 spirit)
create or replace function public.check_production_mutable()
returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'completed' then
      raise exception 'INV-03: completed production orders are immutable'; end if;
    return old;
  end if;
  if old.status = 'completed' then
    raise exception 'INV-03: completed production orders are immutable';
  end if;
  return new;
end $$;

drop trigger if exists trg_production_immutable on public.production_orders;
create trigger trg_production_immutable
  before update or delete on public.production_orders
  for each row execute function public.check_production_mutable();

-- ============================================================================
-- Phase 8: platform administration (PLATFORM_ADMIN.md, BACKUP_AND_RECOVERY.md)
--   * read-only enforcement for suspended/deactivated tenants (defense in depth)
--   * hash-chained platform audit log (separate chain from tenants)
-- Platform-owned tables (plans, subscriptions, feature_flags, usage_metrics,
-- support_grants, platform_audit_log, platform_settings, backup_runs,
-- platform_alerts, rate_limits, tenant_exports, deletion_requests) are
-- deliberately NOT tenant-scoped and hold no tenant financial content; they are
-- reachable only through the platform session namespace (/platform) and every
-- mutation is written to platform_audit_log.
-- ============================================================================

-- Read-only mode flag, set per transaction by the application when the tenant
-- is not active (suspended/deactivated ⇒ read-only + export, never destructive).
create or replace function public.app_read_only() returns boolean
language sql stable as $$
  select coalesce(nullif(current_setting('app.read_only', true), ''), 'off') in ('on', 'true', '1')
$$;

-- Restrictive policies: they AND with the permissive tenant policies, so a
-- read-only session keeps full read visibility but cannot INSERT/UPDATE/DELETE.
-- audit_log is intentionally exempt: a blocked attempt must still be auditable.
do $$
declare
  t text;
begin
  for t in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relname <> 'audit_log'
      and exists (
        select 1 from information_schema.columns col
        where col.table_schema = 'public' and col.table_name = c.relname
          and col.column_name = 'tenant_id'
      )
      and exists (
        select 1 from pg_policies p
        where p.schemaname = 'public' and p.tablename = c.relname
          and p.policyname = 'tenant_isolation'
      )
  loop
    execute format('drop policy if exists tenant_readonly_insert on public.%I', t);
    execute format(
      'create policy tenant_readonly_insert on public.%I as restrictive for insert with check (not public.app_read_only())',
      t
    );
    execute format('drop policy if exists tenant_readonly_update on public.%I', t);
    execute format(
      'create policy tenant_readonly_update on public.%I as restrictive for update using (not public.app_read_only()) with check (not public.app_read_only())',
      t
    );
    execute format('drop policy if exists tenant_readonly_delete on public.%I', t);
    execute format(
      'create policy tenant_readonly_delete on public.%I as restrictive for delete using (not public.app_read_only())',
      t
    );
  end loop;
end $$;

-- Platform audit chain (PLATFORM_ADMIN §3) — append-only, per-platform chain.
create or replace function public.write_platform_audit(
  p_id uuid,
  p_actor_platform_user_id uuid,
  p_actor_label text,
  p_action text,
  p_entity text,
  p_entity_id text,
  p_before jsonb,
  p_after jsonb,
  p_ip text,
  p_user_agent text
) returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_prev text;
  v_hash text;
begin
  perform pg_advisory_xact_lock(hashtextextended('platform_audit', 0));

  select a.hash into v_prev
  from public.platform_audit_log a
  order by a.at desc, a.id desc
  limit 1;

  v_hash := encode(digest(
    coalesce(v_prev, '') || '|' ||
    coalesce(p_actor_label, '') || '|' || p_action || '|' ||
    coalesce(p_entity, '') || '|' || coalesce(p_entity_id, '') || '|' ||
    coalesce(p_after::text, '') || '|' || clock_timestamp()::text,
    'sha256'
  ), 'hex');

  insert into public.platform_audit_log (
    id, actor_platform_user_id, actor_label, action, entity, entity_id,
    "before", "after", ip, user_agent, prev_hash, hash
  ) values (
    p_id, p_actor_platform_user_id, p_actor_label, p_action, p_entity, p_entity_id,
    p_before, p_after, p_ip, p_user_agent, v_prev, v_hash
  );

  return p_id;
end;
$$;

revoke update, delete on public.platform_audit_log from public;
