create table public.workflow_session_roles (
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('qa', 'vault_operator')),
  active boolean not null default true,
  granted_by uuid not null references auth.users(id),
  granted_at timestamptz not null default now(),
  primary key (user_id, role)
);

create table public.workflow_session_approvals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  approved_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  constraint workflow_session_approvals_expiry_check
    check (expires_at > created_at and expires_at <= created_at + interval '5 minutes')
);

create table public.workflow_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  auth_session_id uuid not null,
  kind text not null check (kind in ('staging', 'vault')),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'active'
    check (status in ('active', 'terminated', 'expired', 'revoked')),
  approval_id uuid references public.workflow_session_approvals(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_validated_at timestamptz,
  terminated_at timestamptz,
  terminated_by uuid,
  constraint workflow_sessions_expiry_check check (
    (kind = 'staging' and expires_at > created_at and expires_at <= created_at + interval '1 hour')
    or (kind = 'vault' and expires_at > created_at and expires_at <= created_at + interval '15 minutes')
  )
);

create table public.workflow_session_handoffs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  workflow_session_id uuid not null references public.workflow_sessions(id) on delete cascade,
  code_hash text not null unique check (code_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  constraint workflow_session_handoffs_expiry_check
    check (expires_at > created_at and expires_at <= created_at + interval '1 minute')
);

create table public.workflow_cli_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  workflow_session_id uuid not null references public.workflow_sessions(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_validated_at timestamptz,
  constraint workflow_cli_sessions_expiry_check
    check (expires_at > created_at and expires_at <= created_at + interval '15 minutes')
);

create table public.workflow_session_audit (
  id bigint generated always as identity primary key,
  actor_id uuid,
  subject_id uuid,
  session_id uuid,
  kind text check (kind is null or kind in ('staging', 'vault')),
  action text not null check (action in (
    'role.granted',
    'role.revoked',
    'vault.approval.created',
    'session.created',
    'session.validated',
    'session.expired',
    'session.terminated',
    'session.revoked',
    'session.access_denied',
    'audit.read',
    'cli.handoff.issued',
    'cli.handoff.consumed',
    'cli.session.validated',
    'cli.session.denied'
  )),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index workflow_session_roles_active_idx
  on public.workflow_session_roles (user_id, role) where active;
create index workflow_session_approvals_pending_idx
  on public.workflow_session_approvals (user_id, expires_at)
  where consumed_at is null;
create index workflow_sessions_owner_kind_idx
  on public.workflow_sessions (user_id, kind, expires_at);
create index workflow_session_handoffs_expiry_idx
  on public.workflow_session_handoffs (expires_at)
  where consumed_at is null;
create index workflow_cli_sessions_parent_idx
  on public.workflow_cli_sessions (workflow_session_id, expires_at);
create unique index workflow_sessions_one_active_per_kind_idx
  on public.workflow_sessions (user_id, kind) where status = 'active';
create index workflow_session_audit_created_at_idx
  on public.workflow_session_audit (created_at desc);
create index workflow_session_audit_subject_idx
  on public.workflow_session_audit (subject_id, created_at desc);

revoke all on public.workflow_session_roles,
  public.workflow_session_approvals,
  public.workflow_sessions,
  public.workflow_session_handoffs,
  public.workflow_cli_sessions,
  public.workflow_session_audit
  from public, anon, authenticated, service_role;
revoke all on sequence public.workflow_session_audit_id_seq
  from public, anon, authenticated, service_role;

alter table public.workflow_session_roles enable row level security;
alter table public.workflow_session_approvals enable row level security;
alter table public.workflow_sessions enable row level security;
alter table public.workflow_session_handoffs enable row level security;
alter table public.workflow_cli_sessions enable row level security;
alter table public.workflow_session_audit enable row level security;

drop function if exists public.manage_workflow_session(uuid, text, text, uuid, text, uuid, text, uuid, uuid);

create or replace function public.manage_workflow_session(
  p_actor_id uuid,
  p_action text,
  p_kind text default null,
  p_session_id uuid default null,
  p_token_hash text default null,
  p_target_user_id uuid default null,
  p_role text default null,
  p_approval_id uuid default null,
  p_auth_session_id uuid default null,
  p_cli_token_hash text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := now();
  v_is_admin boolean := false;
  v_authorized boolean := false;
  v_session public.workflow_sessions%rowtype;
  v_approval public.workflow_session_approvals%rowtype;
  v_handoff public.workflow_session_handoffs%rowtype;
  v_cli_session public.workflow_cli_sessions%rowtype;
  v_role_kind text;
  v_events jsonb;
  v_revoked_count integer := 0;
begin
  if p_actor_id is null and p_action not in ('redeem_cli_handoff', 'validate_cli_session') then
    return jsonb_build_object('ok', false, 'code', 'invalid');
  end if;

  if p_action = 'redeem_cli_handoff' then
    if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$'
      or p_cli_token_hash is null or p_cli_token_hash !~ '^[0-9a-f]{64}$' then
      return jsonb_build_object('ok', false, 'code', 'invalid');
    end if;
    select * into v_handoff
      from public.workflow_session_handoffs
     where code_hash = p_token_hash
     for update;
    if not found or v_handoff.consumed_at is not null or v_handoff.expires_at <= v_now then
      return jsonb_build_object('ok', false, 'code', 'not_found');
    end if;
    select * into v_session
      from public.workflow_sessions
     where id = v_handoff.workflow_session_id
     for update;
    if not found or v_session.user_id <> v_handoff.user_id or v_session.kind <> 'vault'
      or v_session.status <> 'active' or v_session.expires_at <= v_now
      or not exists (
        select 1 from auth.sessions
         where id = v_session.auth_session_id and user_id = v_session.user_id
      )
      or not exists (
        select 1 from public.workflow_session_roles
         where user_id = v_session.user_id and role = 'vault_operator' and active
      ) then
      update public.workflow_session_handoffs
         set consumed_at = v_now
       where id = v_handoff.id;
      insert into public.workflow_session_audit (actor_id, subject_id, session_id, kind, action, details)
      values (
        v_handoff.user_id, v_handoff.user_id, v_session.id, 'vault', 'cli.session.denied',
        jsonb_build_object('reason', 'vault_session_inactive')
      );
      return jsonb_build_object('ok', false, 'code', 'revoked');
    end if;
    update public.workflow_session_handoffs set consumed_at = v_now where id = v_handoff.id;
    insert into public.workflow_cli_sessions (
      user_id, workflow_session_id, token_hash, created_at, expires_at
    )
    values (
      v_session.user_id, v_session.id, p_cli_token_hash, v_now,
      least(v_session.expires_at, v_now + interval '15 minutes')
    )
    returning * into v_cli_session;
    insert into public.workflow_session_audit (actor_id, subject_id, session_id, kind, action, details)
    values (
      v_session.user_id, v_session.user_id, v_session.id, 'vault', 'cli.handoff.consumed',
      jsonb_build_object('expiresAt', v_cli_session.expires_at)
    );
    return jsonb_build_object(
      'ok', true, 'userId', v_cli_session.user_id, 'sessionId', v_session.id,
      'expiresAt', v_cli_session.expires_at
    );
  end if;

  if p_action = 'validate_cli_session' then
    if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
      return jsonb_build_object('ok', false, 'code', 'not_found');
    end if;
    select * into v_cli_session
      from public.workflow_cli_sessions
     where token_hash = p_token_hash
     for update;
    if not found then
      return jsonb_build_object('ok', false, 'code', 'not_found');
    end if;
    select * into v_session
      from public.workflow_sessions
     where id = v_cli_session.workflow_session_id
     for update;
    if not found or v_session.user_id <> v_cli_session.user_id
      or v_session.kind <> 'vault' or v_session.status <> 'active'
      or v_session.expires_at <= v_now or v_cli_session.expires_at <= v_now
      or not exists (
        select 1 from auth.sessions
         where id = v_session.auth_session_id and user_id = v_session.user_id
      )
      or not exists (
        select 1 from public.workflow_session_roles
         where user_id = v_session.user_id and role = 'vault_operator' and active
      ) then
      insert into public.workflow_session_audit (actor_id, subject_id, session_id, kind, action, details)
      values (
        v_cli_session.user_id, v_cli_session.user_id, v_cli_session.workflow_session_id,
        'vault', 'cli.session.denied', jsonb_build_object('reason', 'session_inactive')
      );
      return jsonb_build_object('ok', false, 'code', 'revoked');
    end if;
    update public.workflow_cli_sessions set last_validated_at = v_now where id = v_cli_session.id;
    insert into public.workflow_session_audit (actor_id, subject_id, session_id, kind, action)
    values (v_cli_session.user_id, v_cli_session.user_id, v_session.id, 'vault', 'cli.session.validated');
    return jsonb_build_object(
      'ok', true, 'userId', v_cli_session.user_id, 'sessionId', v_session.id,
      'kind', 'vault', 'status', 'active', 'expiresAt', v_cli_session.expires_at
    );
  end if;

  if p_action = 'auth_denied' then
    insert into public.workflow_session_audit (actor_id, action, details)
    values (p_actor_id, 'session.access_denied', jsonb_build_object('reason', 'aal2_required'));
    return jsonb_build_object('ok', false, 'code', 'forbidden');
  end if;

  if p_action = 'approval_denied' then
    insert into public.workflow_session_audit (actor_id, subject_id, kind, action, details)
    values (p_actor_id, p_actor_id, 'vault', 'session.access_denied', jsonb_build_object('reason', 'approval_missing_or_invalid'));
    return jsonb_build_object('ok', false, 'code', 'approval_invalid');
  end if;

  if p_action = 'revoke_user_sessions' then
    for v_session in
      update public.workflow_sessions
         set status = 'revoked', terminated_at = v_now, terminated_by = p_actor_id
       where user_id = p_actor_id and status = 'active'
       returning *
    loop
      insert into public.workflow_session_audit (actor_id, subject_id, session_id, kind, action, details)
      values (p_actor_id, p_actor_id, v_session.id, v_session.kind, 'session.revoked', jsonb_build_object('reason', 'account_deletion'));
      v_revoked_count := v_revoked_count + 1;
    end loop;
    if v_revoked_count = 0 then
      insert into public.workflow_session_audit (actor_id, subject_id, action, details)
      values (p_actor_id, p_actor_id, 'session.revoked', jsonb_build_object('reason', 'account_deletion', 'activeSessions', 0));
    end if;
    return jsonb_build_object('ok', true);
  end if;

  v_is_admin := public.has_role(p_actor_id, 'admin'::public.app_role);

  if p_action in ('grant_role', 'revoke_role') then
    if not v_is_admin then
      insert into public.workflow_session_audit (actor_id, subject_id, action, details)
      values (p_actor_id, p_target_user_id, 'session.access_denied', jsonb_build_object('reason', 'admin_role_required'));
      return jsonb_build_object('ok', false, 'code', 'forbidden');
    end if;
    if p_target_user_id is null or p_target_user_id = p_actor_id
      or p_role is null or p_role not in ('qa', 'vault_operator') then
      return jsonb_build_object('ok', false, 'code', 'invalid');
    end if;
    if not exists (select 1 from auth.users where id = p_target_user_id) then
      return jsonb_build_object('ok', false, 'code', 'not_found');
    end if;

    v_role_kind := case when p_role = 'qa' then 'staging' else 'vault' end;
    if p_action = 'grant_role' then
      insert into public.workflow_session_roles (user_id, role, active, granted_by, granted_at)
      values (p_target_user_id, p_role, true, p_actor_id, v_now)
      on conflict (user_id, role) do update
        set active = true, granted_by = excluded.granted_by, granted_at = excluded.granted_at;
      insert into public.workflow_session_audit (actor_id, subject_id, kind, action, details)
      values (p_actor_id, p_target_user_id, v_role_kind, 'role.granted', jsonb_build_object('role', p_role));
      return jsonb_build_object('ok', true, 'role', p_role, 'userId', p_target_user_id);
    end if;

    update public.workflow_session_roles
       set active = false
     where user_id = p_target_user_id and role = p_role and active;
    if not found then
      insert into public.workflow_session_audit (actor_id, subject_id, kind, action, details)
      values (p_actor_id, p_target_user_id, v_role_kind, 'session.access_denied', jsonb_build_object('reason', 'role_not_active'));
      return jsonb_build_object('ok', false, 'code', 'not_found');
    end if;
    for v_session in
      update public.workflow_sessions
         set status = 'revoked', terminated_at = v_now, terminated_by = p_actor_id
       where user_id = p_target_user_id and kind = v_role_kind and status = 'active'
       returning *
    loop
      insert into public.workflow_session_audit (actor_id, subject_id, session_id, kind, action)
      values (p_actor_id, v_session.user_id, v_session.id, v_session.kind, 'session.revoked');
    end loop;
    insert into public.workflow_session_audit (actor_id, subject_id, kind, action, details)
    values (p_actor_id, p_target_user_id, v_role_kind, 'role.revoked', jsonb_build_object('role', p_role));
    return jsonb_build_object('ok', true, 'role', p_role, 'userId', p_target_user_id);
  end if;

  if p_action = 'approve_vault' then
    if not v_is_admin then
      insert into public.workflow_session_audit (actor_id, subject_id, kind, action, details)
      values (p_actor_id, p_target_user_id, 'vault', 'session.access_denied', jsonb_build_object('reason', 'admin_role_required'));
      return jsonb_build_object('ok', false, 'code', 'forbidden');
    end if;
    if p_target_user_id is null or p_target_user_id = p_actor_id then
      return jsonb_build_object('ok', false, 'code', 'invalid');
    end if;
    if not exists (
      select 1 from public.workflow_session_roles
       where user_id = p_target_user_id and role = 'vault_operator' and active
    ) then
      insert into public.workflow_session_audit (actor_id, subject_id, kind, action, details)
      values (p_actor_id, p_target_user_id, 'vault', 'session.access_denied', jsonb_build_object('reason', 'vault_operator_role_required'));
      return jsonb_build_object('ok', false, 'code', 'forbidden');
    end if;

    insert into public.workflow_session_approvals (user_id, approved_by, created_at, expires_at)
    values (p_target_user_id, p_actor_id, v_now, v_now + interval '5 minutes')
    returning * into v_approval;
    insert into public.workflow_session_audit (actor_id, subject_id, kind, action, details)
    values (
      p_actor_id, p_target_user_id, 'vault', 'vault.approval.created',
      jsonb_build_object('approvalId', v_approval.id, 'expiresAt', v_approval.expires_at)
    );
    return jsonb_build_object('ok', true, 'approvalId', v_approval.id, 'expiresAt', v_approval.expires_at);
  end if;

  if p_action = 'create' then
    if p_kind is null or p_kind not in ('staging', 'vault')
      or p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$'
      or p_auth_session_id is null then
      return jsonb_build_object('ok', false, 'code', 'invalid');
    end if;
    if not exists (
      select 1 from auth.sessions
       where id = p_auth_session_id and user_id = p_actor_id
    ) then
      insert into public.workflow_session_audit (actor_id, subject_id, kind, action, details)
      values (p_actor_id, p_actor_id, p_kind, 'session.access_denied', jsonb_build_object('reason', 'supabase_session_inactive'));
      return jsonb_build_object('ok', false, 'code', 'forbidden');
    end if;
    v_authorized := case
      when p_kind = 'staging' then v_is_admin or exists (
        select 1 from public.workflow_session_roles
         where user_id = p_actor_id and active and role = 'qa'
      )
      else exists (
        select 1 from public.workflow_session_roles
         where user_id = p_actor_id and active and role = 'vault_operator'
      )
    end;
    if not v_authorized then
      insert into public.workflow_session_audit (actor_id, subject_id, kind, action, details)
      values (p_actor_id, p_actor_id, p_kind, 'session.access_denied', jsonb_build_object('reason', 'role_required'));
      return jsonb_build_object('ok', false, 'code', 'forbidden');
    end if;

    if p_action = 'issue_cli_handoff' then
      if p_session_id is null or p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
        return jsonb_build_object('ok', false, 'code', 'invalid');
      end if;
      select * into v_session
        from public.workflow_sessions
       where id = p_session_id and user_id = p_actor_id
       for update;
      if not found or v_session.kind <> 'vault' or v_session.status <> 'active'
        or v_session.expires_at <= v_now
        or not exists (
          select 1 from auth.sessions
           where id = v_session.auth_session_id and user_id = p_actor_id
        )
        or not exists (
          select 1 from public.workflow_session_roles
           where user_id = p_actor_id and role = 'vault_operator' and active
        ) then
        insert into public.workflow_session_audit (actor_id, subject_id, session_id, kind, action, details)
        values (p_actor_id, p_actor_id, p_session_id, 'vault', 'session.access_denied', jsonb_build_object('reason', 'vault_session_inactive'));
        return jsonb_build_object('ok', false, 'code', 'forbidden');
      end if;
      update public.workflow_session_handoffs
         set consumed_at = v_now
       where workflow_session_id = p_session_id and consumed_at is null;
      insert into public.workflow_session_handoffs (
        user_id, workflow_session_id, code_hash, created_at, expires_at
      )
      values (p_actor_id, p_session_id, p_token_hash, v_now, v_now + interval '1 minute')
      returning * into v_handoff;
      insert into public.workflow_session_audit (actor_id, subject_id, session_id, kind, action, details)
      values (
        p_actor_id, p_actor_id, p_session_id, 'vault', 'cli.handoff.issued',
        jsonb_build_object('expiresAt', v_handoff.expires_at)
      );
      return jsonb_build_object('ok', true, 'expiresAt', v_handoff.expires_at);
    end if;

    perform pg_advisory_xact_lock(hashtextextended(p_actor_id::text || ':' || p_kind, 0));
    for v_session in
      update public.workflow_sessions
         set status = 'expired', terminated_at = v_now
       where user_id = p_actor_id and kind = p_kind
         and status = 'active' and expires_at <= v_now
       returning *
    loop
      insert into public.workflow_session_audit (actor_id, subject_id, session_id, kind, action)
      values (p_actor_id, p_actor_id, v_session.id, p_kind, 'session.expired');
    end loop;
    if exists (
      select 1 from public.workflow_sessions
       where user_id = p_actor_id and kind = p_kind and status = 'active'
    ) then
      insert into public.workflow_session_audit (actor_id, subject_id, kind, action, details)
      values (p_actor_id, p_actor_id, p_kind, 'session.access_denied', jsonb_build_object('reason', 'active_session_exists'));
      return jsonb_build_object('ok', false, 'code', 'conflict');
    end if;

    if p_kind = 'vault' then
      if p_approval_id is null then
        insert into public.workflow_session_audit (actor_id, subject_id, kind, action, details)
        values (p_actor_id, p_actor_id, 'vault', 'session.access_denied', jsonb_build_object('reason', 'approval_required'));
        return jsonb_build_object('ok', false, 'code', 'approval_required');
      end if;
      select * into v_approval
        from public.workflow_session_approvals
       where id = p_approval_id and user_id = p_actor_id
       for update;
      if not found or v_approval.consumed_at is not null or v_approval.expires_at <= v_now
        or v_approval.approved_by = p_actor_id
        or not public.has_role(v_approval.approved_by, 'admin'::public.app_role) then
        insert into public.workflow_session_audit (actor_id, subject_id, kind, action, details)
        values (p_actor_id, p_actor_id, 'vault', 'session.access_denied', jsonb_build_object('reason', 'approval_invalid'));
        return jsonb_build_object('ok', false, 'code', 'approval_invalid');
      end if;
      update public.workflow_session_approvals set consumed_at = v_now where id = v_approval.id;
    end if;

    insert into public.workflow_sessions (
      user_id, auth_session_id, kind, token_hash, approval_id, created_at, expires_at
    )
    values (
      p_actor_id, p_auth_session_id, p_kind, p_token_hash,
      case when p_kind = 'vault' then p_approval_id else null end,
      v_now, v_now + case when p_kind = 'staging' then interval '1 hour' else interval '15 minutes' end
    )
    returning * into v_session;
    insert into public.workflow_session_audit (actor_id, subject_id, session_id, kind, action, details)
    values (
      p_actor_id, p_actor_id, v_session.id, p_kind, 'session.created',
      jsonb_build_object('expiresAt', v_session.expires_at, 'approvalId', v_session.approval_id)
    );
    return jsonb_build_object(
      'ok', true, 'sessionId', v_session.id, 'kind', v_session.kind,
      'status', v_session.status, 'expiresAt', v_session.expires_at
    );
  end if;

  if p_action = 'validate' then
    if p_kind is null or p_kind not in ('staging', 'vault')
      or p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
      return jsonb_build_object('ok', false, 'code', 'not_found');
    end if;
    select * into v_session
      from public.workflow_sessions
     where token_hash = p_token_hash and kind = p_kind
     for update;
    if not found then
      insert into public.workflow_session_audit (actor_id, subject_id, kind, action, details)
      values (p_actor_id, p_actor_id, coalesce(v_session.kind, p_kind), 'session.access_denied', jsonb_build_object('reason', 'unknown_session'));
      return jsonb_build_object('ok', false, 'code', 'not_found');
    end if;
    if v_session.user_id <> p_actor_id then
      insert into public.workflow_session_audit (actor_id, subject_id, session_id, kind, action, details)
      values (p_actor_id, v_session.user_id, v_session.id, p_kind, 'session.access_denied', jsonb_build_object('reason', 'owner_mismatch'));
      return jsonb_build_object('ok', false, 'code', 'forbidden');
    end if;
    if p_auth_session_id is null or v_session.auth_session_id <> p_auth_session_id then
      insert into public.workflow_session_audit (actor_id, subject_id, session_id, kind, action, details)
      values (p_actor_id, v_session.user_id, v_session.id, p_kind, 'session.access_denied', jsonb_build_object('reason', 'auth_session_mismatch'));
      return jsonb_build_object('ok', false, 'code', 'forbidden');
    end if;
    if not exists (
      select 1 from auth.sessions
       where id = p_auth_session_id and user_id = p_actor_id
    ) then
      update public.workflow_sessions
         set status = 'revoked', terminated_at = v_now
       where id = v_session.id;
      insert into public.workflow_session_audit (actor_id, subject_id, session_id, kind, action, details)
      values (p_actor_id, p_actor_id, v_session.id, p_kind, 'session.revoked', jsonb_build_object('reason', 'supabase_session_inactive'));
      return jsonb_build_object('ok', false, 'code', 'revoked');
    end if;
    if v_session.status <> 'active' then
      return jsonb_build_object('ok', false, 'code', v_session.status);
    end if;
    v_authorized := case
      when p_kind = 'staging' then public.has_role(p_actor_id, 'admin'::public.app_role) or exists (
        select 1 from public.workflow_session_roles
         where user_id = p_actor_id and active and role = 'qa'
      )
      else exists (
        select 1 from public.workflow_session_roles
         where user_id = p_actor_id and active and role = 'vault_operator'
      )
    end;
    if not v_authorized then
      update public.workflow_sessions
         set status = 'revoked', terminated_at = v_now
       where id = v_session.id;
      insert into public.workflow_session_audit (actor_id, subject_id, session_id, kind, action, details)
      values (p_actor_id, p_actor_id, v_session.id, p_kind, 'session.revoked', jsonb_build_object('reason', 'role_revoked'));
      return jsonb_build_object('ok', false, 'code', 'revoked');
    end if;
    if v_session.expires_at <= v_now then
      update public.workflow_sessions
         set status = 'expired', terminated_at = v_now
       where id = v_session.id;
      insert into public.workflow_session_audit (actor_id, subject_id, session_id, kind, action)
      values (p_actor_id, p_actor_id, v_session.id, p_kind, 'session.expired');
      return jsonb_build_object('ok', false, 'code', 'expired');
    end if;
    update public.workflow_sessions set last_validated_at = v_now where id = v_session.id;
    insert into public.workflow_session_audit (actor_id, subject_id, session_id, kind, action)
    values (p_actor_id, p_actor_id, v_session.id, p_kind, 'session.validated');
    return jsonb_build_object(
      'ok', true, 'sessionId', v_session.id, 'kind', v_session.kind,
      'status', v_session.status, 'expiresAt', v_session.expires_at
    );
  end if;

  if p_action = 'terminate' then
    if p_session_id is not null then
      select * into v_session from public.workflow_sessions where id = p_session_id for update;
    elsif p_kind in ('staging', 'vault') and p_token_hash ~ '^[0-9a-f]{64}$' then
      select * into v_session
        from public.workflow_sessions
       where token_hash = p_token_hash and kind = p_kind
       for update;
    else
      return jsonb_build_object('ok', false, 'code', 'invalid');
    end if;
    if not found then
      insert into public.workflow_session_audit (actor_id, subject_id, kind, action, details)
      values (p_actor_id, p_actor_id, coalesce(v_session.kind, p_kind), 'session.access_denied', jsonb_build_object('reason', 'unknown_session'));
      return jsonb_build_object('ok', false, 'code', 'not_found');
    end if;
    if v_session.user_id <> p_actor_id and not v_is_admin then
      insert into public.workflow_session_audit (actor_id, subject_id, session_id, kind, action, details)
      values (p_actor_id, v_session.user_id, v_session.id, v_session.kind, 'session.access_denied', jsonb_build_object('reason', 'owner_or_admin_required'));
      return jsonb_build_object('ok', false, 'code', 'forbidden');
    end if;
    if v_session.status <> 'active' then
      return jsonb_build_object('ok', false, 'code', v_session.status);
    end if;
    if v_session.expires_at <= v_now then
      update public.workflow_sessions
         set status = 'expired', terminated_at = v_now
       where id = v_session.id;
      insert into public.workflow_session_audit (actor_id, subject_id, session_id, kind, action)
      values (p_actor_id, v_session.user_id, v_session.id, v_session.kind, 'session.expired');
      return jsonb_build_object('ok', false, 'code', 'expired');
    end if;
    update public.workflow_sessions
       set status = 'terminated', terminated_at = v_now, terminated_by = p_actor_id
     where id = v_session.id;
    insert into public.workflow_session_audit (actor_id, subject_id, session_id, kind, action)
    values (p_actor_id, v_session.user_id, v_session.id, v_session.kind, 'session.terminated');
    return jsonb_build_object('ok', true, 'sessionId', v_session.id, 'status', 'terminated');
  end if;

  if p_action = 'read_audit' then
    if not v_is_admin then
      insert into public.workflow_session_audit (actor_id, action, details)
      values (p_actor_id, 'session.access_denied', jsonb_build_object('reason', 'admin_role_required'));
      return jsonb_build_object('ok', false, 'code', 'forbidden');
    end if;
    insert into public.workflow_session_audit (actor_id, action)
    values (p_actor_id, 'audit.read');
    select coalesce(jsonb_agg(to_jsonb(a) order by a.created_at desc), '[]'::jsonb)
      into v_events
      from (
        select id, actor_id, subject_id, session_id, kind, action, details, created_at
          from public.workflow_session_audit
         order by created_at desc, id desc
         limit 100
      ) as a;
    return jsonb_build_object('ok', true, 'events', v_events);
  end if;

  return jsonb_build_object('ok', false, 'code', 'invalid');
end;
$function$;

revoke all on function public.manage_workflow_session(uuid, text, text, uuid, text, uuid, text, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.manage_workflow_session(uuid, text, text, uuid, text, uuid, text, uuid, uuid, text)
  to service_role;