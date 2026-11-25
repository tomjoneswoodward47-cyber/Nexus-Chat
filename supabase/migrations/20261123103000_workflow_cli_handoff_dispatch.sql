alter function public.manage_workflow_session(uuid, text, text, uuid, text, uuid, text, uuid, uuid, text)
  rename to manage_workflow_session_legacy;

create or replace function public.issue_workflow_cli_handoff(
  p_actor_id uuid,
  p_session_id uuid,
  p_code_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := now();
  v_session public.workflow_sessions%rowtype;
  v_handoff public.workflow_session_handoffs%rowtype;
begin
  if p_actor_id is null or p_session_id is null
    or p_code_hash is null or p_code_hash !~ '^[0-9a-f]{64}$' then
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
    values (
      p_actor_id, p_actor_id, p_session_id, 'vault', 'session.access_denied',
      jsonb_build_object('reason', 'vault_session_inactive')
    );
    return jsonb_build_object('ok', false, 'code', 'forbidden');
  end if;

  update public.workflow_session_handoffs
     set consumed_at = v_now
   where workflow_session_id = p_session_id and consumed_at is null;
  insert into public.workflow_session_handoffs (
    user_id, workflow_session_id, code_hash, created_at, expires_at
  )
  values (p_actor_id, p_session_id, p_code_hash, v_now, v_now + interval '1 minute')
  returning * into v_handoff;

  insert into public.workflow_session_audit (actor_id, subject_id, session_id, kind, action, details)
  values (
    p_actor_id, p_actor_id, p_session_id, 'vault', 'cli.handoff.issued',
    jsonb_build_object('expiresAt', v_handoff.expires_at)
  );
  return jsonb_build_object('ok', true, 'expiresAt', v_handoff.expires_at);
end;
$function$;

revoke all on function public.issue_workflow_cli_handoff(uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.issue_workflow_cli_handoff(uuid, uuid, text)
  to service_role;

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
begin
  if p_action = 'issue_cli_handoff' then
    return public.issue_workflow_cli_handoff(p_actor_id, p_session_id, p_token_hash);
  end if;

  return public.manage_workflow_session_legacy(
    p_actor_id, p_action, p_kind, p_session_id, p_token_hash,
    p_target_user_id, p_role, p_approval_id, p_auth_session_id, p_cli_token_hash
  );
end;
$function$;

revoke all on function public.manage_workflow_session_legacy(uuid, text, text, uuid, text, uuid, text, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.manage_workflow_session_legacy(uuid, text, text, uuid, text, uuid, text, uuid, uuid, text)
  to service_role;
revoke all on function public.manage_workflow_session(uuid, text, text, uuid, text, uuid, text, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.manage_workflow_session(uuid, text, text, uuid, text, uuid, text, uuid, uuid, text)
  to service_role;
