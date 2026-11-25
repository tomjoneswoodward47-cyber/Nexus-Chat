-- Nexus Chat schema for your own Supabase project.
-- Idempotent: safe to run on a fresh project or re-run against an existing one.
-- Re-running only adds what is missing (new columns, tables, policies) and
-- refreshes existing definitions; it never drops data.
--
-- ===========================================================================
-- Schema reconciliation record
-- ===========================================================================
-- 2026-11-24 — this file was reconciled against supabase/migrations so the
-- production apply path (psql -f docs/supabase-schema.sql from setup-production.yml,
-- and scripts/setup-supabase.js) reaches the same object state as the shipped
-- migration set. Every object those migrations create is now defined here and
-- superseded definitions were replaced:
--   added     content_reports / blocked_users, list_member_profiles,
--             chats.participant_names plus its backfill and list_my_contacts,
--             the e2ee key directory (e2ee_public_keys with
--             publish_e2ee_public_key / list_chat_public_keys),
--             call_push_subscriptions, user_storage (reserve_user_storage /
--             commit_user_storage and the create_user_storage trigger),
--             attachments with the inline Base64 payload columns,
--             can_read_contact_avatar, feed event metadata (post_type / title /
--             event_starts_at / event_location), kyc_sessions and its status
--             detail columns, and the six workflow_session_* tables with
--             manage_workflow_session, manage_workflow_session_legacy and
--             issue_workflow_cli_handoff.
--   changed   messages.messages_text_requires_encryption now exempts the 'call'
--             type (20261028092157); messages.file_size was added
--             (20261124120000); is_chat_member is owner-scoped
--             (20261027133018); chat-files reads are owner/admin scoped
--             (20261110000000); attachments follow the R2/S3 plus inline hybrid
--             (20261029130000).
--   removed   the client-trusted instant identity approval RPC (retired by
--             20261123140000) and every retired payment / storage-upgrade
--             object, RPC and QR policy (20261020090000).
-- Verified  npm run test:schema (11/11) and a dry-run of scripts/setup-supabase.js
--           load and hash every checked-in migration; the object inventory here
--           was diffed against supabase/migrations/*.sql (tables, columns,
--           indexes, constraints, functions, policies and grants). The file
--           stays idempotent: if not exists / drop ... if exists /
--           create or replace / duplicate_object guards throughout.
-- Caveat    The raw migration directory is not from-scratch safe on its own:
--           20261012091153 creates public.app_role with three labels while the
--           later 20261012105742 re-creates it with two, so replaying every
--           file onto an empty database stops at the second. This file creates
--           the two-label enum directly and is unaffected. Guard that create
--           type (or retire the superseded file) before treating the full set
--           as from-scratch reproducible.
-- ===========================================================================

insert into storage.buckets (id, name, public) values ('chat-files','chat-files', false), ('identity-docs','identity-docs', false) on conflict do nothing;

-- from 20261012105742_7f3801e7-d165-4bbd-a733-0f29089dd2ad.sql
do $$ begin
  create type public.app_role as enum ('admin','user');
exception when duplicate_object then null; end $$;
create table if not exists public.user_roles (id uuid primary key default gen_random_uuid(), user_id uuid references auth.users(id) on delete cascade not null, role public.app_role not null, created_at timestamptz not null default now(), unique(user_id, role));
grant select on public.user_roles to authenticated; grant all on public.user_roles to service_role;
alter table public.user_roles enable row level security;
create or replace function public.has_role(_user_id uuid, _role public.app_role) returns boolean language sql stable security definer set search_path = public as $$ select exists(select 1 from public.user_roles where user_id=_user_id and role=_role) $$;
drop policy if exists "Users see own roles" on public.user_roles;
create policy "Users see own roles" on public.user_roles for select to authenticated using (user_id = auth.uid() or public.has_role(auth.uid(),'admin'));

create or replace function public.update_updated_at_column() returns trigger language plpgsql set search_path = public as $$ begin new.updated_at = now(); return new; end; $$;

create table if not exists public.identity_verifications (id uuid primary key default gen_random_uuid(), user_id uuid not null unique, status text not null default 'pending', match_score numeric, selfie_path text not null, id_document_path text not null, reviewer_note text, reviewed_by uuid, reviewed_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
grant select, insert, update on public.identity_verifications to authenticated; grant all on public.identity_verifications to service_role;
alter table public.identity_verifications enable row level security;
drop policy if exists "Own or admin read" on public.identity_verifications;
create policy "Own or admin read" on public.identity_verifications for select to authenticated using (user_id = auth.uid() or public.has_role(auth.uid(),'admin'));
drop policy if exists "Submit own pending" on public.identity_verifications;
create policy "Submit own pending" on public.identity_verifications for insert to authenticated with check (user_id = auth.uid() and status = 'pending' and reviewed_by is null);
drop policy if exists "Resubmit own after rejection" on public.identity_verifications;
create policy "Resubmit own after rejection" on public.identity_verifications for update to authenticated using (user_id = auth.uid() and status = 'rejected') with check (user_id = auth.uid() and status = 'pending' and reviewed_by is null);
drop policy if exists "Admins review" on public.identity_verifications;
create policy "Admins review" on public.identity_verifications for update to authenticated using (public.has_role(auth.uid(),'admin')) with check (public.has_role(auth.uid(),'admin'));
drop trigger if exists trg_idv_updated on public.identity_verifications;
create trigger trg_idv_updated before update on public.identity_verifications for each row execute function public.update_updated_at_column();

create table if not exists public.storage_files (id uuid primary key default gen_random_uuid(), user_id uuid not null, chat_id text, file_name text not null, file_type text not null, mime_type text, size_bytes bigint not null default 0, duration_seconds numeric, storage_path text not null, created_at timestamptz not null default now());
grant select, insert, delete on public.storage_files to authenticated; grant all on public.storage_files to service_role;
alter table public.storage_files enable row level security;
drop policy if exists "Own files" on public.storage_files;
create policy "Own files" on public.storage_files for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create or replace function public.get_verification_badge(_user_id uuid) returns text language sql stable security definer set search_path = public as $$
  select case
    when exists(select 1 from public.identity_verifications where user_id=_user_id and status='approved') then 'authenticated'
    when exists(select 1 from auth.users where id=_user_id and email_confirmed_at is not null) then 'verified'
    else 'none' end $$;
grant execute on function public.get_verification_badge(uuid) to anon, authenticated;

drop policy if exists "ID docs own upload" on storage.objects;
create policy "ID docs own upload" on storage.objects for insert to authenticated with check (bucket_id='identity-docs' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "ID docs own or admin read" on storage.objects;
create policy "ID docs own or admin read" on storage.objects for select to authenticated using (bucket_id='identity-docs' and ((storage.foldername(name))[1] = auth.uid()::text or public.has_role(auth.uid(),'admin')));
drop policy if exists "Chat files own upload" on storage.objects;
create policy "Chat files own upload" on storage.objects for insert to authenticated with check (bucket_id='chat-files' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "Chat files own or admin read" on storage.objects;
create policy "Chat files own or admin read" on storage.objects for select to authenticated using (bucket_id='chat-files' and ((storage.foldername(name))[1] = auth.uid()::text or public.has_role(auth.uid(),'admin')));
drop policy if exists "Chat files own delete" on storage.objects;
create policy "Chat files own delete" on storage.objects for delete to authenticated using (bucket_id='chat-files' and (storage.foldername(name))[1] = auth.uid()::text);
-- from 20261012105808_722066b4-005b-47d7-aa9a-df0f18f3aeed.sql
revoke execute on function public.has_role(uuid, public.app_role) from public, anon;
revoke execute on function public.get_verification_badge(uuid) from public, anon;
grant execute on function public.get_verification_badge(uuid) to authenticated;
-- from 20261012110244_880a9c2a-16c5-4d14-8803-b9bf93c0faab.sql
create table if not exists public.members (
  id uuid primary key references auth.users(id) on delete cascade,
  auth_user_id uuid not null unique,
  member_id text not null unique,
  first_name text, last_name text, full_name text,
  email text not null unique,
  email_verified boolean not null default false,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Appwrite identity links are server-only and may only be changed by the trusted API.
create table if not exists public.appwrite_identity_links (
  appwrite_user_id text primary key,
  supabase_user_id uuid not null unique references auth.users(id) on delete cascade,
  linked_email text not null,
  linked_at timestamptz not null default now()
);
alter table public.appwrite_identity_links enable row level security;
revoke all on public.appwrite_identity_links from public, anon, authenticated;
grant all on public.appwrite_identity_links to service_role;
grant select, update on public.members to authenticated;
grant all on public.members to service_role;
alter table public.members enable row level security;
drop policy if exists "Read own profile" on public.members;
create policy "Read own profile" on public.members for select to authenticated using (id = auth.uid() or public.has_role(auth.uid(),'admin'));
drop policy if exists "Edit own profile" on public.members;
create policy "Edit own profile" on public.members for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
drop trigger if exists trg_members_updated on public.members;
create trigger trg_members_updated before update on public.members for each row execute function public.update_updated_at_column();

-- Block people from changing protected fields on their own profile
create or replace function public.protect_member_fields() returns trigger language plpgsql set search_path = public as $$
begin
  if current_user = 'authenticated' then
    new.member_id := old.member_id; new.email := old.email;
    new.email_verified := old.email_verified; new.auth_user_id := old.auth_user_id;
  end if;
  return new;
end $$;
drop trigger if exists trg_members_protect on public.members;
create trigger trg_members_protect before update on public.members for each row execute function public.protect_member_fields();

create or replace function public.handle_new_member() returns trigger language plpgsql security definer set search_path = public as $$
declare mid text := coalesce(nullif(new.raw_user_meta_data->>'member_id',''), '10' || lpad((floor(random()*100000000))::text, 8, '0'));
begin
  insert into public.members (id, auth_user_id, member_id, first_name, last_name, full_name, email, email_verified)
  values (new.id, new.id, mid, new.raw_user_meta_data->>'first_name', new.raw_user_meta_data->>'last_name',
    nullif(trim(coalesce(new.raw_user_meta_data->>'first_name','') || ' ' || coalesce(new.raw_user_meta_data->>'last_name','')), ''),
    lower(new.email), new.email_confirmed_at is not null)
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_member();

create or replace function public.sync_member_email() returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.members set email = lower(new.email), email_verified = new.email_confirmed_at is not null where id = new.id;
  return new;
end $$;
drop trigger if exists on_auth_user_updated on auth.users;
create trigger on_auth_user_updated after update of email, email_confirmed_at on auth.users for each row execute function public.sync_member_email();
revoke execute on function public.handle_new_member() from public, anon, authenticated;
revoke execute on function public.sync_member_email() from public, anon, authenticated;

-- Backfill existing accounts
insert into public.members (id, auth_user_id, member_id, first_name, last_name, full_name, email, email_verified)
select u.id, u.id, coalesce(nullif(u.raw_user_meta_data->>'member_id',''), '10' || lpad((floor(random()*100000000))::text, 8, '0')),
  u.raw_user_meta_data->>'first_name', u.raw_user_meta_data->>'last_name',
  nullif(trim(coalesce(u.raw_user_meta_data->>'first_name','') || ' ' || coalesce(u.raw_user_meta_data->>'last_name','')), ''),
  lower(u.email), u.email_confirmed_at is not null
from auth.users u where u.email is not null on conflict do nothing;

-- Find a person by their Nexus number (only public details)
create or replace function public.lookup_member_by_nexus_id(p_member_id text)
returns table (id uuid, member_id text, first_name text, last_name text, full_name text, avatar_url text)
language sql stable security definer set search_path = public as $$
  select id, member_id, first_name, last_name, full_name, avatar_url from public.members where member_id = p_member_id limit 1 $$;
revoke execute on function public.lookup_member_by_nexus_id(text) from public, anon;
grant execute on function public.lookup_member_by_nexus_id(text) to authenticated;
-- from 20261012113128_6f6c8415-a46e-4446-84e3-c5951468a2fe.sql
alter table public.members add column if not exists bio text, add column if not exists interests text[];
-- from 20261012122632_31486d60-08f7-48ec-a6e7-0d32384bd185.sql
CREATE TABLE IF NOT EXISTS public.auth_email_code_limits (
  bucket_key text PRIMARY KEY,
  window_start timestamp with time zone NOT NULL DEFAULT now(),
  count integer NOT NULL DEFAULT 0
);

GRANT ALL ON public.auth_email_code_limits TO service_role;

ALTER TABLE public.auth_email_code_limits ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.consume_auth_email_code_limit(p_bucket_key text, p_window_seconds integer, p_limit integer)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_start timestamp with time zone;
  v_count integer;
BEGIN
  INSERT INTO public.auth_email_code_limits (bucket_key, window_start, count)
  VALUES (p_bucket_key, now(), 1)
  ON CONFLICT (bucket_key) DO NOTHING;

  SELECT window_start, count INTO v_start, v_count
  FROM public.auth_email_code_limits
  WHERE bucket_key = p_bucket_key
  FOR UPDATE;

  IF v_start < now() - make_interval(secs => p_window_seconds) THEN
    UPDATE public.auth_email_code_limits
    SET window_start = now(), count = 1
    WHERE bucket_key = p_bucket_key;
    RETURN true;
  END IF;

  IF v_count >= p_limit THEN
    RETURN false;
  END IF;

  UPDATE public.auth_email_code_limits
  SET count = count + 1
  WHERE bucket_key = p_bucket_key;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_auth_email_code_limit(text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_auth_email_code_limit(text, integer, integer) TO service_role;

-- Server-issued one-time email codes. The server generates a short numeric code,
-- stores only a keyed hash of it, and checks the hash server-side before a
-- Supabase session is issued. Codes are single-use, expire after ten minutes and
-- are invalidated after a few wrong guesses.
CREATE TABLE IF NOT EXISTS public.auth_email_codes (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  email text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('signup', 'recovery', 'email')),
  code_hash text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  expires_at timestamp with time zone NOT NULL,
  consumed_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS auth_email_codes_lookup_idx
  ON public.auth_email_codes (email, purpose, created_at DESC);

ALTER TABLE public.auth_email_codes ENABLE ROW LEVEL SECURITY;
-- No policies: only the service role, which bypasses RLS, may read or write codes.
REVOKE ALL ON public.auth_email_codes FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.auth_email_codes TO service_role;

-- Atomically checks a submitted code. Returns 'ok' | 'invalid' | 'expired' |
-- 'too_many_attempts' | 'not_found'. Attempts are counted on every try so a
-- short code cannot be brute-forced online.
CREATE OR REPLACE FUNCTION public.verify_auth_email_code(
  p_email text,
  p_purpose text,
  p_code_hash text,
  p_max_attempts integer DEFAULT 5
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_code public.auth_email_codes;
BEGIN
  SELECT * INTO v_code
  FROM public.auth_email_codes
  WHERE email = p_email AND purpose = p_purpose AND consumed_at IS NULL
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;

  IF v_code.expires_at < now() THEN
    UPDATE public.auth_email_codes SET consumed_at = now() WHERE id = v_code.id;
    RETURN 'expired';
  END IF;

  IF v_code.attempts >= p_max_attempts THEN
    UPDATE public.auth_email_codes SET consumed_at = now() WHERE id = v_code.id;
    RETURN 'too_many_attempts';
  END IF;

  UPDATE public.auth_email_codes SET attempts = attempts + 1 WHERE id = v_code.id;

  IF v_code.code_hash = p_code_hash THEN
    UPDATE public.auth_email_codes SET consumed_at = now() WHERE id = v_code.id;
    RETURN 'ok';
  END IF;

  IF v_code.attempts + 1 >= p_max_attempts THEN
    UPDATE public.auth_email_codes SET consumed_at = now() WHERE id = v_code.id;
    RETURN 'too_many_attempts';
  END IF;

  RETURN 'invalid';
END;
$$;

REVOKE ALL ON FUNCTION public.verify_auth_email_code(text, text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_auth_email_code(text, text, text, integer) TO service_role;
-- Contacts
create table if not exists public.contacts (id uuid primary key default gen_random_uuid(), user_id uuid not null, name text not null, nexus_id text not null, avatar_url text, created_at timestamptz not null default now(), unique (user_id, nexus_id));
grant select, insert, update, delete on public.contacts to authenticated; grant all on public.contacts to service_role;
alter table public.contacts enable row level security;
drop policy if exists "Own contacts" on public.contacts;
create policy "Own contacts" on public.contacts for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Chat transport (replaces Appwrite)
create table if not exists public.chats (
  id uuid primary key default gen_random_uuid(), title text not null default 'New Chat', type text not null default 'private',
  avatar_url text, encrypted boolean not null default false, owner_id uuid, created_at timestamptz not null default now()
);
create table if not exists public.chat_members (
  chat_id uuid not null references public.chats(id) on delete cascade, profile_id uuid not null,
  joined_at timestamptz not null default now(), primary key (chat_id, profile_id)
);
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(), chat_id uuid not null references public.chats(id) on delete cascade,
  sender_id uuid, content text not null check (char_length(content) between 1 and 65535), type text not null default 'text',
  file_url text, file_name text, file_size bigint, duration numeric, encrypted boolean not null default false, created_at timestamptz not null default now(),
  -- Type list kept in step with 20261028092157_call_history_message_type.sql, which
  -- added 'call' so call-history rows may carry non-encrypted content.
  constraint messages_text_requires_encryption check (
    type in ('reaction', 'receipt', 'image', 'video', 'voice', 'file', 'document', 'call') or (
      encrypted is true
      and jsonb_typeof(content::jsonb) = 'object'
      and (content::jsonb - 'alg' - 'iv' - 'data') = '{}'::jsonb
      and content::jsonb ->> 'alg' = 'ECDH-P256+AES-256-GCM'
      and content::jsonb ->> 'alg' is not null
      and content::jsonb ->> 'iv' is not null
      and content::jsonb ->> 'data' is not null
      and (content::jsonb ->> 'iv') ~ '^[A-Za-z0-9+/]{16}$'
      and (content::jsonb ->> 'data') ~ '^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$'
      and length(content::jsonb ->> 'data') >= 24
      and mod(length(content::jsonb ->> 'data'), 4) = 0
      and (3 * (length(content::jsonb ->> 'data') / 4)
        - case
            when right(content::jsonb ->> 'data', 2) = '==' then 2
            when right(content::jsonb ->> 'data', 1) = '=' then 1
            else 0
          end) >= 17
    )
  )
);
create index if not exists idx_chat_members_profile on public.chat_members(profile_id);
create index if not exists idx_messages_chat_created on public.messages(chat_id, created_at);
-- Added after the initial release: the byte size of a chat attachment, used to
-- render the compact file preview (type icon, name, size) in the message list.
alter table public.messages add column if not exists file_size bigint;
grant select, insert, update, delete on public.chats, public.chat_members, public.messages to authenticated;
grant all on public.chats, public.chat_members, public.messages to service_role;
alter table public.chats enable row level security;
alter table public.chat_members enable row level security;
alter table public.messages enable row level security;
create or replace function public.is_chat_member(_chat uuid, _user uuid) returns boolean language sql stable security definer set search_path = public as $$
  -- Hardened in 20261027133018_secure_chat_file_access.sql: the caller may only
  -- probe their own membership, so the function cannot be used to confirm another
  -- user's chat membership.
  select _user = (select auth.uid())
    and exists (select 1 from public.chat_members where chat_id = _chat and profile_id = _user) $$;
drop policy if exists "View own chats" on public.chats;
create policy "View own chats" on public.chats for select to authenticated using (owner_id = auth.uid() or public.is_chat_member(id, auth.uid()));
drop policy if exists "Create owned chats" on public.chats;
create policy "Create owned chats" on public.chats for insert to authenticated with check (owner_id = auth.uid());
drop policy if exists "Owners update chats" on public.chats;
create policy "Owners update chats" on public.chats for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
drop policy if exists "Owners delete chats" on public.chats;
create policy "Owners delete chats" on public.chats for delete to authenticated using (owner_id = auth.uid());
drop policy if exists "View memberships of my chats" on public.chat_members;
create policy "View memberships of my chats" on public.chat_members for select to authenticated using (public.is_chat_member(chat_id, auth.uid()));
drop policy if exists "Owners add members" on public.chat_members;
create policy "Owners add members" on public.chat_members for insert to authenticated with check (exists (select 1 from public.chats c where c.id = chat_id and c.owner_id = auth.uid()));
drop policy if exists "Leave chats" on public.chat_members;
create policy "Leave chats" on public.chat_members for delete to authenticated using (profile_id = auth.uid());
drop policy if exists "Members read messages" on public.messages;
create policy "Members read messages" on public.messages for select to authenticated using (public.is_chat_member(chat_id, auth.uid()) or public.has_role(auth.uid(),'admin'));
drop policy if exists "Members send messages" on public.messages;
create policy "Members send messages" on public.messages for insert to authenticated with check (sender_id = auth.uid() and public.is_chat_member(chat_id, auth.uid()));
drop policy if exists "Senders delete messages" on public.messages;
create policy "Senders delete messages" on public.messages for delete to authenticated using (sender_id = auth.uid());
revoke execute on function public.is_chat_member(uuid, uuid) from public, anon;
grant execute on function public.is_chat_member(uuid, uuid) to authenticated, service_role;
revoke execute on function public.handle_new_member() from public, anon, authenticated;
revoke execute on function public.sync_member_email() from public, anon, authenticated;
revoke execute on function public.lookup_member_by_nexus_id(text) from public, anon;
grant execute on function public.has_role(uuid, public.app_role) to authenticated, service_role;
grant execute on function public.lookup_member_by_nexus_id(text) to authenticated, service_role;

do $$ begin alter publication supabase_realtime add table public.contacts; exception when others then null; end $$;
do $$ begin alter publication supabase_realtime add table public.messages; exception when others then null; end $$;
do $$ begin alter publication supabase_realtime add table public.chat_members; exception when others then null; end $$;

create or replace function public.admin_exists() returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.user_roles where role='admin') $$;
revoke execute on function public.admin_exists() from public, anon;
grant execute on function public.admin_exists() to authenticated;

drop policy if exists "Own ID docs upload" on storage.objects;
drop policy if exists "Own ID docs read or admin" on storage.objects;
create policy "Own ID docs upload" on storage.objects for insert to authenticated with check (bucket_id='identity-docs' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "Own ID docs read or admin" on storage.objects for select to authenticated using (bucket_id='identity-docs' and ((storage.foldername(name))[1] = auth.uid()::text or public.has_role(auth.uid(),'admin')));
-- 20261013212651_a266bd67-bc53-4083-af85-83df904ae8ad.sql
create unique index if not exists identity_verifications_user_id_key on public.identity_verifications(user_id);
create or replace function public.stamp_idv_review() returns trigger language plpgsql set search_path = public as $$
begin
  if new.status in ('approved','rejected') and new.status is distinct from old.status then
    new.reviewed_by := auth.uid(); new.reviewed_at := now();
  end if;
  return new;
end $$;
drop trigger if exists trg_idv_review on public.identity_verifications;
create trigger trg_idv_review before update on public.identity_verifications for each row execute function public.stamp_idv_review();-- security hardening
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated, service_role;

-- move privileged bodies into the non-exposed schema. Guarded so a re-run does
-- not collide with the copies already living in the private schema.
do $$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'private' and p.proname = 'admin_exists') then
    alter function public.admin_exists() set schema private;
  end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'private' and p.proname = 'get_verification_badge') then
    alter function public.get_verification_badge(uuid) set schema private;
  end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'private' and p.proname = 'lookup_member_by_nexus_id') then
    alter function public.lookup_member_by_nexus_id(text) set schema private;
  end if;
end $$;

revoke execute on all functions in schema private from public, anon;
grant execute on function private.admin_exists(), private.get_verification_badge(uuid),
  private.lookup_member_by_nexus_id(text) to authenticated;

-- thin invoker wrappers keep the same API names
create or replace function public.admin_exists() returns boolean language sql stable security invoker set search_path = public as $$ select private.admin_exists() $$;
create or replace function public.get_verification_badge(_user_id uuid) returns text language sql stable security invoker set search_path = public as $$ select private.get_verification_badge(_user_id) $$;
create or replace function public.lookup_member_by_nexus_id(p_member_id text) returns table(id uuid, member_id text, first_name text, last_name text, full_name text, avatar_url text) language sql stable security invoker set search_path = public as $$ select * from private.lookup_member_by_nexus_id(p_member_id) $$;
revoke execute on function public.admin_exists(), public.get_verification_badge(uuid), public.lookup_member_by_nexus_id(text) from public, anon;
grant execute on function public.admin_exists(), public.get_verification_badge(uuid), public.lookup_member_by_nexus_id(text) to authenticated;

-- rate limiter is server-only
revoke execute on function public.consume_auth_email_code_limit(text,integer,integer) from public, anon, authenticated;
grant execute on function public.consume_auth_email_code_limit(text,integer,integer) to service_role;

-- server-only table: explicit deny policy documents intent
drop policy if exists "No client access" on public.auth_email_code_limits;
create policy "No client access" on public.auth_email_code_limits for all to authenticated, anon using (false) with check (false);

-- Admin member management (admin-only RPCs)
create schema if not exists private;
create or replace function private.admin_update_member(_member_id uuid, _first_name text, _last_name text, _bio text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.has_role(auth.uid(), 'admin') then raise exception 'Admins only'; end if;
  update public.members set first_name = left(trim(_first_name),80), last_name = left(trim(_last_name),80),
    full_name = left(trim(coalesce(_first_name,'')||' '||coalesce(_last_name,'')),161), bio = left(_bio,500), updated_at = now()
  where id = _member_id;
end $$;
create or replace function private.admin_set_admin_role(_user_id uuid, _grant boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.has_role(auth.uid(), 'admin') then raise exception 'Admins only'; end if;
  if _grant then
    insert into public.user_roles(user_id, role) select _user_id, 'admin'
    where not exists (select 1 from public.user_roles where user_id=_user_id and role='admin');
  else
    if _user_id = auth.uid() then raise exception 'You cannot remove your own admin role'; end if;
    delete from public.user_roles where user_id=_user_id and role='admin';
  end if;
end $$;
create or replace function private.admin_list_admins()
returns table(user_id uuid) language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_role(auth.uid(), 'admin') then raise exception 'Admins only'; end if;
  return query select r.user_id from public.user_roles r where r.role='admin';
end $$;
grant usage on schema private to authenticated;
grant execute on function private.admin_update_member(uuid,text,text,text), private.admin_set_admin_role(uuid,boolean), private.admin_list_admins() to authenticated;
create or replace function public.admin_update_member(_member_id uuid, _first_name text, _last_name text, _bio text)
returns void language sql set search_path = public as $$ select private.admin_update_member(_member_id,_first_name,_last_name,_bio) $$;
create or replace function public.admin_set_admin_role(_user_id uuid, _grant boolean)
returns void language sql set search_path = public as $$ select private.admin_set_admin_role(_user_id,_grant) $$;
create or replace function public.admin_list_admins()
returns table(user_id uuid) language sql stable set search_path = public as $$ select * from private.admin_list_admins() $$;
revoke all on function public.admin_update_member(uuid,text,text,text), public.admin_set_admin_role(uuid,boolean), public.admin_list_admins() from public, anon;
grant execute on function public.admin_update_member(uuid,text,text,text), public.admin_set_admin_role(uuid,boolean), public.admin_list_admins() to authenticated;

-- Admin review of ID checks: only admins, only pending rows, records reviewer and time.
create or replace function public.review_identity_verification(_id uuid, _approve boolean, _note text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.has_role(auth.uid(),'admin') then raise exception 'Admins only'; end if;
  update public.identity_verifications
    set status = case when _approve then 'approved' else 'rejected' end,
        reviewer_note = case when _approve then null else nullif(left(trim(coalesce(_note,'')), 500), '') end,
        reviewed_by = auth.uid(), reviewed_at = now()
    where id = _id and status = 'pending';
  if not found then raise exception 'This ID check is no longer waiting for review'; end if;
end $$;
revoke execute on function public.review_identity_verification(uuid,boolean,text) from public, anon;
grant execute on function public.review_identity_verification(uuid,boolean,text) to authenticated;
-- 20261017020000_premium_member_badges.sql
-- Premium Member badges (blue) are granted ONLY by an admin through the admin
-- panel. KYC (gold) badges are granted ONLY when an admin approves an ID check.
-- Nothing is auto-assigned at signup, and every grant/revoke/review is recorded
-- in an admin audit log so badge assignments are traceable to an admin action.
create table if not exists public.premium_members (
  user_id uuid primary key,
  granted_by uuid,
  granted_at timestamptz not null default now(),
  note text
);
revoke all on public.premium_members from public, anon;
grant select on public.premium_members to authenticated;
grant all on public.premium_members to service_role;
alter table public.premium_members enable row level security;
drop policy if exists "Own or admin read premium" on public.premium_members;
create policy "Own or admin read premium" on public.premium_members
  for select to authenticated
  using (user_id = auth.uid() or public.has_role(auth.uid(), 'admin'));

create table if not exists public.admin_audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid,
  action text not null,
  target_user_id uuid,
  details jsonb,
  created_at timestamptz not null default now()
);
revoke all on public.admin_audit_log from public, anon;
grant select on public.admin_audit_log to authenticated;
grant all on public.admin_audit_log to service_role;
alter table public.admin_audit_log enable row level security;
drop policy if exists "Admins read audit log" on public.admin_audit_log;
create policy "Admins read audit log" on public.admin_audit_log
  for select to authenticated
  using (public.has_role(auth.uid(), 'admin'));

create or replace function private.admin_set_premium_member(_user_id uuid, _grant boolean, _note text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.has_role(auth.uid(), 'admin') then raise exception 'Admins only'; end if;
  if _user_id is null then raise exception 'A member is required'; end if;

  if _grant then
    insert into public.premium_members (user_id, granted_by, granted_at, note)
    values (_user_id, auth.uid(), now(), nullif(left(trim(coalesce(_note, '')), 500), ''))
    on conflict (user_id) do update
      set granted_by = excluded.granted_by, granted_at = excluded.granted_at, note = excluded.note;
  else
    delete from public.premium_members where user_id = _user_id;
  end if;

  insert into public.admin_audit_log (actor_id, action, target_user_id, details)
  values (
    auth.uid(),
    case when _grant then 'premium_member.granted' else 'premium_member.revoked' end,
    _user_id,
    jsonb_build_object('note', nullif(left(trim(coalesce(_note, '')), 500), ''))
  );
end $$;
grant execute on function private.admin_set_premium_member(uuid, boolean, text) to authenticated;

create or replace function public.admin_set_premium_member(_user_id uuid, _grant boolean, _note text default null)
returns void language sql security invoker set search_path = public as $$
  select private.admin_set_premium_member(_user_id, _grant, _note)
$$;
revoke all on function public.admin_set_premium_member(uuid, boolean, text) from public, anon;
grant execute on function public.admin_set_premium_member(uuid, boolean, text) to authenticated;

-- Badge levels: 'premium' (blue, admin-granted) > 'authenticated' (blue, either
-- identity-verification tier approved) > 'none'. A confirmed email never grants a badge.
create or replace function private.get_verification_badge(_user_id uuid)
returns text language sql stable security definer set search_path = public as $$
  select case
    when exists (select 1 from public.premium_members where user_id = _user_id) then 'premium'
    when exists (select 1 from public.identity_verifications where user_id = _user_id and status = 'approved') then 'authenticated'
    else 'none' end $$;
grant execute on function private.get_verification_badge(uuid) to authenticated;

create or replace function public.get_verification_badge(_user_id uuid)
returns text language sql stable security invoker set search_path = public as $$
  select private.get_verification_badge(_user_id)
$$;
revoke execute on function public.get_verification_badge(uuid) from public, anon;
grant execute on function public.get_verification_badge(uuid) to authenticated;

-- Batch lookup so user directories (contacts) resolve every badge in one call.
create or replace function private.get_verification_badges(_member_ids text[])
returns table(member_id text, badge text) language sql stable security definer set search_path = public as $$
  select m.member_id,
    case
      when exists (select 1 from public.premium_members p where p.user_id = m.id) then 'premium'
      when exists (select 1 from public.identity_verifications v where v.user_id = m.id and v.status = 'approved') then 'authenticated'
      else 'none' end
  from public.members m
  where m.member_id = any(_member_ids)
  limit 500 $$;
revoke execute on function private.get_verification_badges(text[]) from public, anon;
grant execute on function private.get_verification_badges(text[]) to authenticated;

create or replace function public.get_verification_badges(_member_ids text[])
returns table(member_id text, badge text) language sql stable security invoker set search_path = public as $$
  select * from private.get_verification_badges(_member_ids)
$$;
revoke execute on function public.get_verification_badges(text[]) from public, anon;
grant execute on function public.get_verification_badges(text[]) to authenticated;

create or replace function public.review_identity_verification(_id uuid, _approve boolean, _note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare _user_id uuid;
begin
  if not public.has_role(auth.uid(), 'admin') then raise exception 'Admins only'; end if;
  update public.identity_verifications
    set status = case when _approve then 'approved' else 'rejected' end,
        reviewer_note = case when _approve then null else nullif(left(trim(coalesce(_note, '')), 500), '') end,
        reviewed_by = auth.uid(), reviewed_at = now()
    where id = _id and status = 'pending'
    returning user_id into _user_id;
  if _user_id is null then raise exception 'This ID check is no longer waiting for review'; end if;

  insert into public.admin_audit_log (actor_id, action, target_user_id, details)
  values (
    auth.uid(),
    case when _approve then 'kyc.approved' else 'kyc.rejected' end,
    _user_id,
    jsonb_build_object('verification_id', _id, 'note', nullif(left(trim(coalesce(_note, '')), 500), ''))
  );
end $$;
revoke execute on function public.review_identity_verification(uuid, boolean, text) from public, anon;
grant execute on function public.review_identity_verification(uuid, boolean, text) to authenticated;
-- 20261017030000_identity_verification_tiers.sql
-- APPLIED to production woavhlkgylarngqyvphf ("Nexus Next") on 2026-10-17. See the deployment record at the end of this file.
-- Dual-tier identity verification.
--
-- Tier 1 (instant, primary): the app matches the selfie on-device and calls the
--   security-definer RPC below, which records an already-approved row for the
--   caller only. The blue verified badge is shown as soon as this succeeds.
-- Tier 2 (manual, secondary): the member completes a structured form and uploads
--   a government ID plus a selfie; the row stays 'pending' until an admin
--   approves it through review_identity_verification.
--
-- Both tiers resolve to the same blue verified badge. Email confirmation never
-- grants any badge, and only this RPC (not the browser) can self-approve.
alter table public.identity_verifications
  add column if not exists tier text,
  add column if not exists full_legal_name text,
  add column if not exists date_of_birth date,
  add column if not exists document_type text,
  add column if not exists document_number text,
  add column if not exists issuing_country text;

-- Rows created before this migration are treated as manual submissions.
update public.identity_verifications set tier = 'manual' where tier is null;

-- The instant tier has no government document, so the ID path becomes optional
-- (20261017030000); the Idswyft KYC path likewise no longer stores a selfie path
-- (20261108090000_gate_instant_kyc_approval.sql).
alter table public.identity_verifications alter column id_document_path drop not null;
alter table public.identity_verifications alter column selfie_path drop not null;

do $$ begin
  alter table public.identity_verifications
    add constraint identity_verifications_tier_check check (tier in ('instant', 'manual'));
exception when duplicate_object then null; end $$;

-- Instant automated verification. security definer so the member cannot mark
-- arbitrary rows approved: the function only ever writes the caller's own row.
-- Client-trusted instant approval is intentionally not provisioned.

-- 20261017040000_social_feed.sql
-- APPLIED to production woavhlkgylarngqyvphf ("Nexus Next") on 2026-10-17. See the deployment record at the end of this file.
-- Facebook-style social feed: text, image and short-video posts with threaded
-- comments, multi-emoji reactions and admin moderation. Idempotent.
create table if not exists public.feed_posts (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null,
  content text not null default '' check (char_length(content) <= 5000),
  media jsonb not null default '[]'::jsonb,
  is_admin_post boolean not null default false,
  status text not null default 'active' check (status in ('active', 'hidden', 'removed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_feed_posts_created on public.feed_posts(created_at desc);
create index if not exists idx_feed_posts_author on public.feed_posts(author_id);

create table if not exists public.feed_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.feed_posts(id) on delete cascade,
  author_id uuid not null,
  parent_id uuid references public.feed_comments(id) on delete cascade,
  content text not null check (char_length(content) between 1 and 3000),
  status text not null default 'active' check (status in ('active', 'hidden', 'removed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_feed_comments_post on public.feed_comments(post_id, created_at);
create index if not exists idx_feed_comments_parent on public.feed_comments(parent_id);

create table if not exists public.feed_reactions (
  post_id uuid not null references public.feed_posts(id) on delete cascade,
  user_id uuid not null,
  reaction text not null,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

create table if not exists public.feed_comment_reactions (
  comment_id uuid not null references public.feed_comments(id) on delete cascade,
  user_id uuid not null,
  reaction text not null,
  created_at timestamptz not null default now(),
  primary key (comment_id, user_id)
);

grant select, insert, update, delete on public.feed_posts, public.feed_comments to authenticated;
grant select, insert, update, delete on public.feed_reactions, public.feed_comment_reactions to authenticated;
grant all on public.feed_posts, public.feed_comments to service_role;
grant all on public.feed_reactions, public.feed_comment_reactions to service_role;

alter table public.feed_posts enable row level security;
alter table public.feed_comments enable row level security;
alter table public.feed_reactions enable row level security;
alter table public.feed_comment_reactions enable row level security;

drop trigger if exists trg_feed_posts_updated on public.feed_posts;
create trigger trg_feed_posts_updated before update on public.feed_posts
  for each row execute function public.update_updated_at_column();
drop trigger if exists trg_feed_comments_updated on public.feed_comments;
create trigger trg_feed_comments_updated before update on public.feed_comments
  for each row execute function public.update_updated_at_column();

-- Posts: everyone signed in can read active posts; authors manage their own;
-- admins can moderate any post.
drop policy if exists "Read feed posts" on public.feed_posts;
create policy "Read feed posts" on public.feed_posts for select to authenticated
  using (status = 'active' or author_id = auth.uid() or public.has_role(auth.uid(), 'admin'));
drop policy if exists "Create own feed posts" on public.feed_posts;
create policy "Create own feed posts" on public.feed_posts for insert to authenticated
  with check (author_id = auth.uid());
drop policy if exists "Manage own feed posts" on public.feed_posts;
create policy "Manage own feed posts" on public.feed_posts for update to authenticated
  using (author_id = auth.uid() or public.has_role(auth.uid(), 'admin'))
  with check (author_id = auth.uid() or public.has_role(auth.uid(), 'admin'));
drop policy if exists "Delete own feed posts" on public.feed_posts;
create policy "Delete own feed posts" on public.feed_posts for delete to authenticated
  using (author_id = auth.uid() or public.has_role(auth.uid(), 'admin'));

-- Comments: readable with the post; authors edit/delete their own; admins moderate.
drop policy if exists "Read feed comments" on public.feed_comments;
create policy "Read feed comments" on public.feed_comments for select to authenticated
  using (status = 'active' or author_id = auth.uid() or public.has_role(auth.uid(), 'admin'));
drop policy if exists "Create own feed comments" on public.feed_comments;
create policy "Create own feed comments" on public.feed_comments for insert to authenticated
  with check (author_id = auth.uid());
drop policy if exists "Manage own feed comments" on public.feed_comments;
create policy "Manage own feed comments" on public.feed_comments for update to authenticated
  using (author_id = auth.uid() or public.has_role(auth.uid(), 'admin'))
  with check (author_id = auth.uid() or public.has_role(auth.uid(), 'admin'));
drop policy if exists "Delete own feed comments" on public.feed_comments;
create policy "Delete own feed comments" on public.feed_comments for delete to authenticated
  using (author_id = auth.uid() or public.has_role(auth.uid(), 'admin'));

-- Reactions: readable by all signed-in members; each member owns their own row.
drop policy if exists "Read post reactions" on public.feed_reactions;
create policy "Read post reactions" on public.feed_reactions for select to authenticated using (true);
drop policy if exists "Manage own post reactions" on public.feed_reactions;
create policy "Manage own post reactions" on public.feed_reactions for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "Read comment reactions" on public.feed_comment_reactions;
create policy "Read comment reactions" on public.feed_comment_reactions for select to authenticated using (true);
drop policy if exists "Manage own comment reactions" on public.feed_comment_reactions;
create policy "Manage own comment reactions" on public.feed_comment_reactions for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Live feed updates across users and admins.
do $$ begin alter publication supabase_realtime add table public.feed_posts; exception when others then null; end $$;
do $$ begin alter publication supabase_realtime add table public.feed_comments; exception when others then null; end $$;
do $$ begin alter publication supabase_realtime add table public.feed_reactions; exception when others then null; end $$;
do $$ begin alter publication supabase_realtime add table public.feed_comment_reactions; exception when others then null; end $$;

-- 20261017080000_e2ee_default_enabled.sql
-- Default-on end-to-end encryption for newly registered accounts. PREPARED, not
-- yet applied to production (see the deployment record below).
-- The column is created with a false default so existing rows are stamped false
-- (pre-existing accounts keep their opt-in behaviour); the default is then
-- switched to true, so accounts created afterwards are recorded as encrypted by
-- default. The private key never leaves the device, so this column is a status
-- mirror used for audit and post-signup verification, not a sending switch.
alter table public.members
  add column if not exists e2ee_enabled boolean not null default false;
alter table public.members
  add column if not exists e2ee_key_published_at timestamptz;
alter table public.members
  alter column e2ee_enabled set default true;

-- Members record their own provisioning outcome; security definer so the narrow
-- write cannot be widened into an edit of other protected profile columns.
create or replace function public.set_my_e2ee_status(p_enabled boolean, p_key_published boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  update public.members
     set e2ee_enabled = coalesce(p_enabled, e2ee_enabled),
         e2ee_key_published_at = case
           when p_key_published then now()
           else e2ee_key_published_at
         end
   where id = auth.uid();
end $$;
revoke execute on function public.set_my_e2ee_status(boolean, boolean) from public, anon;
grant execute on function public.set_my_e2ee_status(boolean, boolean) to authenticated;

-- ===========================================================================
-- Deployment record (audit trail)
-- ===========================================================================
-- Project   woavhlkgylarngqyvphf ("Nexus Next", org dopuwyqqfvopcvdppvkt, West EU (Ireland))
-- Date      2026-10-17
-- Scope     the two migrations above, applied in dependency order:
--             1. 20261017030000_identity_verification_tiers.sql
--             2. 20261017040000_social_feed.sql
-- Method    `supabase db push --linked`. The 9 migrations already present on the
--           remote database but missing from the CLI's migration history were
--           temporarily excluded so that only these two were pushed, then
--           restored. `--include-all` was deliberately not used, because it would
--           have tried to recreate objects that already exist.
-- Pre-check `supabase db push --linked --dry-run` listed exactly those two files.
-- Backup    supabase/backups/2026-10-17T16-30-17-468Z_public_data.sql
--           SHA-256 39260c6c7d908185760ab7d07853ab2904a85e1543c4b932fe4cabe0bf5b0314
--           16 public tables / 15 rows, produced by scripts/backup-supabase.js
--           Rollback: psql "$SUPABASE_DB_URL" -f supabase/backups/<that file>
--                     (FK checks are disabled for the duration of the restore)
-- Verified  Automated read-only checks against the live database: 74 of 77 passed.
--           - identity_verifications gained tier, full_legal_name, date_of_birth,
--             document_type, document_number, issuing_country (all nullable);
--             id_document_path is now nullable; identity_verifications_tier_check
--             enforces tier in ('instant','manual'). Client-trusted instant
--             self-approval has been retired and must not be provisioned.
--           - feed_posts, feed_comments, feed_reactions and feed_comment_reactions
--             created with RLS enabled, 12 policies, 4 indexes, 2 updated_at
--             triggers, 4 ON DELETE CASCADE foreign keys, grants for
--             authenticated/service_role, and all four added to the
--             supabase_realtime publication.
--           - No data loss: members 3, chats 1, chat_members 2, messages 3,
--             contacts 1, storage_files 1 and auth_email_code_limits 4 all match
--             the pre-migration backup exactly.
--           - No invalid indexes in public and no deadlocks recorded.
-- Notes     1. public.profiles and public.current_member_profile_id() do not exist
--              on this project. That predates this deployment (neither migration
--              drops or renames anything), so the REQUIRED_TABLES and
--              REQUIRED_FUNCTIONS lists in scripts/lib/supabase-schema.js do not
--              fully describe this project. Reconcile separately.
--           2. Supabase logs were not reachable from this workspace: the CLI
--              exposes no log command and no Management API token is stored here.
--              Health was assessed from pg_stat_database instead. Review
--              Dashboard -> Logs -> Postgres for the same window if required.
--           3. Both migrations are also recorded in the CLI's
--              supabase_migrations.schema_migrations history.
-- ===========================================================================

-- ===========================================================================
-- Repository maintenance  2026-10-17  Retired superseded migrations
-- ---------------------------------------------------------------------------
-- Removed    supabase/migrations/20261006000000_initial_nexus_schema.sql
--            supabase/migrations/20261006010000_authenticated_member_lookup.sql
-- Reason     Both files belong to the abandoned profiles-based design. Nothing
--            they create survives on a provisioned project: 20261012110244
--            recreates public.members, the protected-field and Auth triggers
--            (on_auth_user_created / on_auth_user_updated), the account backfill
--            and lookup_member_by_nexus_id; 20261012122632 recreates the
--            email-code rate-limit table and RPC; 20261017000000 recreates
--            chats / chat_members / messages. public.profiles,
--            verify_member_login, current_member_profile_id(),
--            current_member_is_admin(), create_member_for_auth_user(),
--            sync_member_email_from_auth_user(), auth_email_code_rate_limits,
--            on_auth_user_created_nexus_member and
--            on_auth_user_updated_nexus_email are absent from the live schema.
-- DDL        None. No production statement was executed by this change.
-- Effect     Fresh `npm run db:setup` still provisions the full schema from the
--            remaining migration files. A project whose
--            public.nexus_schema_migrations history still lists the retired
--            versions reports them as "exists in source: false" in
--            `npm run db:verify`; that is expected and does not apply to
--            woavhlkgylarngqyvphf, which tracks history in
--            supabase_migrations.schema_migrations.
-- Follow-up  This resolves note 1 above: scripts/lib/supabase-schema.js no longer
--            lists the profiles-based objects, so REQUIRED_TABLES /
--            REQUIRED_FUNCTIONS now match the live schema.
-- ===========================================================================

-- 20261020100000_content_reports_and_blocks.sql
-- User-generated content controls required by the Google Play and Apple App
-- Store policies: members can report offensive content and block abusive
-- members, and admins review the report queue.
create table if not exists public.content_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null,
  target_type text not null check (target_type in ('post', 'comment', 'member')),
  target_id uuid not null,
  reason text not null check (reason in ('spam', 'harassment', 'hate', 'sexual', 'violence', 'misinformation', 'other')),
  details text not null default '' check (char_length(details) <= 2000),
  status text not null default 'open' check (status in ('open', 'reviewed', 'actioned', 'dismissed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_content_reports_status on public.content_reports(status, created_at desc);
create index if not exists idx_content_reports_reporter on public.content_reports(reporter_id);
create unique index if not exists uq_content_reports_open
  on public.content_reports(reporter_id, target_type, target_id)
  where status = 'open';

create table if not exists public.blocked_users (
  blocker_id uuid not null,
  blocked_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
create index if not exists idx_blocked_users_blocked on public.blocked_users(blocked_id);

grant select, insert, update on public.content_reports to authenticated;
grant select, insert, delete on public.blocked_users to authenticated;
grant all on public.content_reports, public.blocked_users to service_role;

alter table public.content_reports enable row level security;
alter table public.blocked_users enable row level security;

drop trigger if exists trg_content_reports_updated on public.content_reports;
create trigger trg_content_reports_updated before update on public.content_reports
  for each row execute function public.update_updated_at_column();

drop policy if exists "Create own reports" on public.content_reports;
create policy "Create own reports" on public.content_reports for insert to authenticated
  with check (reporter_id = auth.uid());
drop policy if exists "Read own or all reports" on public.content_reports;
create policy "Read own or all reports" on public.content_reports for select to authenticated
  using (reporter_id = auth.uid() or public.has_role(auth.uid(), 'admin'));
drop policy if exists "Admins review reports" on public.content_reports;
create policy "Admins review reports" on public.content_reports for update to authenticated
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

drop policy if exists "Read own blocks" on public.blocked_users;
create policy "Read own blocks" on public.blocked_users for select to authenticated
  using (blocker_id = auth.uid());
drop policy if exists "Create own blocks" on public.blocked_users;
create policy "Create own blocks" on public.blocked_users for insert to authenticated
  with check (blocker_id = auth.uid());
drop policy if exists "Delete own blocks" on public.blocked_users;
create policy "Delete own blocks" on public.blocked_users for delete to authenticated
  using (blocker_id = auth.uid());

do $$ begin alter publication supabase_realtime add table public.blocked_users; exception when others then null; end $$;
do $$ begin alter publication supabase_realtime add table public.content_reports; exception when others then null; end $$;

-- 20261020110000_member_profile_directory_rpc.sql
-- Author names must resolve for every member. public.members is readable only for
-- the caller's own row ("Read own profile" above), so the direct members lookups
-- in src/lib/feeds.js and src/lib/moderation.js returned nothing for other
-- authors and every post, comment and blocked account rendered as the
-- "Nexus member" placeholder. This resolver returns directory fields for a list
-- of ids, following the same shape as lookup_member_by_nexus_id and
-- list_my_contacts: security definer, directory fields only, authenticated only.
create or replace function public.list_member_profiles(p_ids uuid[])
returns table (id uuid, member_id text, full_name text, first_name text, last_name text, avatar_url text)
language sql stable security definer set search_path = public as $$
  select m.id, m.member_id, m.full_name, m.first_name, m.last_name, m.avatar_url
  from public.members m
  where m.id = any(coalesce(p_ids, array[]::uuid[]))
  limit 500
$$;
revoke execute on function public.list_member_profiles(uuid[]) from public, anon;
grant execute on function public.list_member_profiles(uuid[]) to authenticated, service_role;

-- ===========================================================================
-- Deployment record   2026-10-20
-- ===========================================================================
-- Scope     supabase/migrations/20261020110000_member_profile_directory_rpc.sql
--           (adds public.list_member_profiles(uuid[])), applied on its own after
--           20261017080000, 20261020090000 and 20261020100000 were confirmed
--           already present on the remote project.
-- Method    scripts/apply-pending-migrations.mjs — one transaction behind an
--           advisory lock, each version recorded in
--           supabase_migrations.schema_migrations; the three earlier files
--           reported SKIP (already applied).
-- Backup    supabase/backups/2026-10-20T18-22-28-217Z_public_data.sql
--           SHA-256 8d0b7415a7d44197e22e76e9ebb3aab9d42bc14c224cb3e954b86a1787ef0239
--           19 public tables / 65 rows, produced by scripts/backup-supabase.js
--           Rollback: drop function public.list_member_profiles(uuid[]);
--           No table, row or policy is touched, so the data backup is
--           precautionary only.
-- Verified  scripts/verify-migration-objects.mjs: 22 of 22 checks passed —
--           list_member_profiles exists, is executable by authenticated and is
--           NOT executable by anon (confirmed via has_function_privilege).
--           Browser check signed in as demo1 on /app/feeds: a post authored by
--           demo2 now renders "Demo Reviewer Two" instead of the
--           "Nexus member" fallback produced by the previous direct table read.
-- ===========================================================================
-- 20261017010000_chat_participant_names.sql
-- Store both participants' display names on the chat so each viewer can render
-- the *other* participant's name (sender sees the recipient, recipient sees the
-- sender) instead of the shared `title`, which was fixed to whoever created it.
alter table public.chats add column if not exists participant_names jsonb;
update public.chats c
set participant_names = sub.names
from (
  select cm.chat_id,
         jsonb_object_agg(
           m.id::text,
           coalesce(
             nullif(trim(m.full_name), ''),
             nullif(trim(concat_ws(' ', m.first_name, m.last_name)), ''),
             m.member_id
           )
         ) as names
  from public.chat_members cm
  join public.members m on m.id = cm.profile_id
  group by cm.chat_id
) sub
where sub.chat_id = c.id and c.participant_names is null;

-- 20261017050000_contact_directory_authority.sql
-- Contact names must follow the live directory, not a stored snapshot: this
-- resolves each contact's display name and avatar from public.members by Nexus
-- number, scoped to the caller's own rows, and repairs the stored snapshot.
create or replace function public.list_my_contacts()
returns table (id uuid, name text, nexus_id text, avatar_url text, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select c.id,
         coalesce(
           nullif(trim(m.full_name), ''),
           nullif(trim(concat_ws(' ', m.first_name, m.last_name)), ''),
           c.name
         ) as name,
         c.nexus_id,
         coalesce(m.avatar_url, c.avatar_url) as avatar_url,
         c.created_at
  from public.contacts c
  left join public.members m on m.member_id = c.nexus_id
  where c.user_id = auth.uid()
  order by c.created_at desc
  limit 500
$$;
revoke execute on function public.list_my_contacts() from public, anon;
grant execute on function public.list_my_contacts() to authenticated, service_role;

update public.contacts c
   set name = coalesce(
         nullif(trim(m.full_name), ''),
         nullif(trim(concat_ws(' ', m.first_name, m.last_name)), ''),
         c.name
       )
  from public.members m
 where m.member_id = c.nexus_id
   and c.name is distinct from coalesce(
         nullif(trim(m.full_name), ''),
         nullif(trim(concat_ws(' ', m.first_name, m.last_name)), ''),
         c.name
       );

-- 20261017060000_e2ee_key_directory.sql
-- End-to-end encryption key directory: the client encrypts 1:1 messages with
-- ECDH P-256 + AES-256-GCM, so each participant's public key must be resolvable
-- server-side. Only public keys are stored; private keys never leave the device.
create table if not exists public.e2ee_public_keys (
  user_id uuid primary key references auth.users(id) on delete cascade,
  public_key text not null,
  algorithm text not null default 'ECDH-P256',
  updated_at timestamptz not null default now()
);
alter table public.e2ee_public_keys enable row level security;
-- No direct client access: reads go through list_chat_public_keys (participant
-- scoped) and writes through publish_e2ee_public_key (caller scoped).
revoke all on public.e2ee_public_keys from public, anon, authenticated;
grant all on public.e2ee_public_keys to service_role;

create or replace function public.publish_e2ee_public_key(p_public_key text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if p_public_key is null or length(p_public_key) < 40 or length(p_public_key) > 800 then
    raise exception 'Invalid public key';
  end if;
  insert into public.e2ee_public_keys (user_id, public_key, updated_at)
  values (auth.uid(), p_public_key, now())
  on conflict (user_id) do update
    set public_key = excluded.public_key, updated_at = now();
end $$;
revoke execute on function public.publish_e2ee_public_key(text) from public, anon;
grant execute on function public.publish_e2ee_public_key(text) to authenticated, service_role;

create or replace function public.list_chat_public_keys(p_chat_id uuid)
returns table (profile_id uuid, public_key text)
language sql stable security definer set search_path = public as $$
  select m.profile_id, k.public_key
  from public.chat_members m
  join public.e2ee_public_keys k on k.user_id = m.profile_id
  where m.chat_id = p_chat_id
    and m.profile_id <> auth.uid()
    and exists (
      select 1 from public.chat_members me
      where me.chat_id = p_chat_id and me.profile_id = auth.uid()
    )
$$;
revoke execute on function public.list_chat_public_keys(uuid) from public, anon;
grant execute on function public.list_chat_public_keys(uuid) to authenticated, service_role;

-- 20261017070000_chat_participant_names_backfill.sql
-- Catch chats created through a path that did not record participant_names.
update public.chats c
set participant_names = sub.names
from (
  select cm.chat_id,
         jsonb_object_agg(
           m.id::text,
           coalesce(
             nullif(trim(m.full_name), ''),
             nullif(trim(concat_ws(' ', m.first_name, m.last_name)), ''),
             m.member_id
           )
         ) as names
  from public.chat_members cm
  join public.members m on m.id = cm.profile_id
  group by cm.chat_id
) sub
where sub.chat_id = c.id
  and (c.participant_names is null or c.participant_names = '{}'::jsonb);

-- 20261027165720_call_push_subscriptions.sql
-- Web Push subscriptions for incoming-call notifications.
create table if not exists public.call_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  platform text not null check (platform in ('web', 'android', 'ios')),
  endpoint text not null,
  p256dh text,
  auth text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint call_push_subscription_web_keys check (
    (platform = 'web' and p256dh is not null and auth is not null)
    or (platform in ('android', 'ios') and p256dh is null and auth is null)
  ),
  constraint call_push_subscription_endpoint_unique unique (platform, endpoint)
);
create index if not exists call_push_subscriptions_user_id_idx
  on public.call_push_subscriptions (user_id);
alter table public.call_push_subscriptions enable row level security;
revoke all on public.call_push_subscriptions from public, anon;
grant select, insert, update, delete on public.call_push_subscriptions to authenticated;
grant select, delete on public.call_push_subscriptions to service_role;
drop policy if exists "Users manage their own call push subscriptions" on public.call_push_subscriptions;
create policy "Users manage their own call push subscriptions"
  on public.call_push_subscriptions
  for all
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- 20261028120000_user_storage.sql
-- Per-user 10GB storage quota counter and the R2/S3 attachment registry.
create table if not exists public.user_storage (
  user_id uuid primary key references auth.users(id) on delete cascade,
  used_bytes bigint not null default 0 check (used_bytes >= 0),
  max_bytes bigint not null default 10737418240,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.user_storage enable row level security;
grant select on public.user_storage to authenticated;
grant all on public.user_storage to service_role;
drop policy if exists "Own storage quota read" on public.user_storage;
create policy "Own storage quota read" on public.user_storage
  for select to authenticated using ((select auth.uid()) = user_id);
drop trigger if exists trg_user_storage_updated on public.user_storage;
create trigger trg_user_storage_updated before update on public.user_storage
  for each row execute function public.update_updated_at_column();

-- Reserve quota under a row lock so concurrent uploads cannot overshoot 10GB.
create or replace function public.reserve_user_storage(p_user_id uuid, p_file_size bigint)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_limit bigint; v_used bigint;
begin
  if p_file_size is null or p_file_size < 0 then raise exception 'INVALID_FILE_SIZE'; end if;
  insert into public.user_storage (user_id) values (p_user_id) on conflict (user_id) do nothing;
  select max_bytes, used_bytes into v_limit, v_used from public.user_storage where user_id = p_user_id for update;
  if v_used + p_file_size > v_limit then raise exception 'STORAGE_QUOTA_EXCEEDED'; end if;
  return true;
end $$;

-- Atomically increment usage after upload (negative reverses a failed confirm).
create or replace function public.commit_user_storage(p_user_id uuid, p_file_size bigint)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_limit bigint; v_used bigint;
begin
  insert into public.user_storage (user_id) values (p_user_id) on conflict (user_id) do nothing;
  select max_bytes, used_bytes into v_limit, v_used from public.user_storage where user_id = p_user_id for update;
  if v_used + p_file_size > v_limit then raise exception 'STORAGE_QUOTA_EXCEEDED'; end if;
  if v_used + p_file_size < 0 then raise exception 'STORAGE_USAGE_UNDERFLOW'; end if;
  update public.user_storage set used_bytes = used_bytes + p_file_size, updated_at = now()
    where user_id = p_user_id returning used_bytes into v_used;
  return v_used;
end $$;

create or replace function public.create_user_storage() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.user_storage (user_id) values (new.id) on conflict (user_id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created_storage on auth.users;
create trigger on_auth_user_created_storage after insert on auth.users
  for each row execute function public.create_user_storage();

insert into public.user_storage (user_id) select id from auth.users on conflict (user_id) do nothing;

-- SECURITY DEFINER functions in the exposed public schema are callable by every
-- role by default, so revoke the default PUBLIC grant and narrow it explicitly.
revoke execute on function public.reserve_user_storage(uuid, bigint) from public, anon;
grant execute on function public.reserve_user_storage(uuid, bigint) to authenticated, service_role;
revoke execute on function public.commit_user_storage(uuid, bigint) from public, anon;
grant execute on function public.commit_user_storage(uuid, bigint) to authenticated, service_role;
revoke execute on function public.create_user_storage() from public, anon, authenticated;

-- Server-owned registry of R2/S3 objects. channel_id records which surface the
-- object belongs to ('feed' = public feed media, otherwise a chat UUID).
create table if not exists public.attachments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  channel_id text,
  file_key text not null unique,
  mime_type text not null,
  file_size bigint not null default 0 check (file_size >= 0),
  created_at timestamptz not null default now()
);
create index if not exists idx_attachments_user on public.attachments(user_id);
create index if not exists idx_attachments_channel on public.attachments(channel_id);
alter table public.attachments enable row level security;
grant select, insert, delete on public.attachments to authenticated;
grant all on public.attachments to service_role;
drop policy if exists "Own attachments" on public.attachments;
create policy "Own attachments" on public.attachments for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- 20261029130000_inline_attachments.sql
-- Hybrid attachment storage: small files are stored inline as Base64 in the
-- attachments row, larger files stay in the R2/S3 bucket. Both share the same
-- 10GB per-user quota via reserve_user_storage / commit_user_storage.
alter table public.attachments
  add column if not exists file_name text not null default '',
  add column if not exists storage_type text not null default 'external_bucket',
  add column if not exists file_data text;
-- Inline rows carry file_data instead of a bucket key, so file_key becomes
-- optional. The existing UNIQUE constraint is retained: Postgres permits many
-- NULLs, so inline rows never collide with each other or with bucket keys.
alter table public.attachments alter column file_key drop not null;
do $$ begin
  alter table public.attachments
    add constraint attachments_storage_type_check
    check (storage_type in ('inline_base64', 'external_bucket'));
exception when duplicate_object then null; end $$;
-- Exactly one payload must be present, matching the declared storage_type, so a
-- row can never hold both a bucket key and inline bytes (or neither).
do $$ begin
  alter table public.attachments
    add constraint attachments_payload_check
    check (
      (storage_type = 'inline_base64' and file_data is not null and file_key is null)
      or (storage_type = 'external_bucket' and file_key is not null and file_data is null)
    );
exception when duplicate_object then null; end $$;

-- 20261105095000_contact_scoped_profile_photos.sql
-- Allow owners, contacts, and active-feed viewers to read only the currently
-- selected profile photo, while preserving blocked-user visibility rules.
create or replace function public.can_read_contact_avatar(_owner_id text, _path text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null and exists (
    select 1
      from public.members m
     where m.id::text = _owner_id
       and m.avatar_url = 'storage://' || _path
       and (
         m.id = auth.uid()
         or (
           (
             exists (
               select 1 from public.contacts c
                where c.nexus_id = m.member_id and c.user_id = auth.uid()
             )
             or exists (
               select 1 from public.feed_posts p
                where p.author_id = m.id and p.status = 'active'
             )
             or exists (
               select 1
                 from public.feed_comments fc
                 join public.feed_posts fp on fp.id = fc.post_id
                where fc.author_id = m.id
                  and (fp.status = 'active' or fp.author_id = auth.uid() or public.has_role(auth.uid(), 'admin'))
                  and (fc.status = 'active' or fc.author_id = auth.uid() or public.has_role(auth.uid(), 'admin'))
             )
             or public.has_role(auth.uid(), 'admin')
           )
           and not exists (
             select 1 from public.blocked_users bu
              where bu.blocker_id = auth.uid() and bu.blocked_id = m.id
           )
         )
       )
  )
$$;
revoke execute on function public.can_read_contact_avatar(text, text) from public, anon;
grant execute on function public.can_read_contact_avatar(text, text) to authenticated, service_role;
drop policy if exists "Contacts read active profile photos" on storage.objects;
create policy "Contacts read active profile photos" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'chat-files'
    and public.can_read_contact_avatar((storage.foldername(name))[1], name)
  );

-- 20261110000000_chat_files_read_owner_scope.sql
-- Reads on the shared chat-files bucket are narrowed to the owner folder plus
-- admins for moderation; recipients render the signed URL stored on the message
-- or feed post and never read the object directly.
drop policy if exists "Chat files signed-in read" on storage.objects;
drop policy if exists "Chat members read chat files" on storage.objects;
drop policy if exists "Chat files own or admin read" on storage.objects;
create policy "Chat files own or admin read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'chat-files'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.has_role(auth.uid(), 'admin'))
  );

-- 20261105102436_feed_event_metadata.sql
-- Calendar-style feed posts: an optional event type with title, start time and
-- location, validated so a general post carries no event metadata.
alter table public.feed_posts
  add column if not exists post_type text not null default 'general',
  add column if not exists title text,
  add column if not exists event_starts_at timestamptz,
  add column if not exists event_location text;
do $$ begin
  alter table public.feed_posts
    add constraint feed_posts_post_type_check
      check (post_type in ('general', 'event'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.feed_posts
    add constraint feed_posts_title_length_check
      check (title is null or char_length(title) <= 160);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.feed_posts
    add constraint feed_posts_event_location_length_check
      check (event_location is null or char_length(event_location) <= 240);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.feed_posts
    add constraint feed_posts_event_metadata_check
      check (
        (post_type = 'event' and nullif(trim(title), '') is not null and event_starts_at is not null)
        or (post_type = 'general' and event_starts_at is null and event_location is null)
      );
exception when duplicate_object then null; end $$;

-- 20261106195234_idswyft_kyc_sessions.sql
-- Idswyft KYC sessions. RLS grants read-only to the owner; the final policy is
-- owner-read-only (20261123140000_retire_client_identity_approval.sql) and all
-- writes happen server-side as service_role.
create table if not exists public.kyc_sessions (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  session_token text not null,
  status text not null check (status in (
    'AWAITING_FRONT',
    'AWAITING_BACK',
    'AWAITING_LIVE',
    'PROCESSING',
    'APPROVED',
    'HARD_REJECTED',
    'SOFT_REJECTED',
    'LIVENESS_FAILED',
    'REVIEW_REQUIRED',
    'FAILED',
    'EXPIRED'
  )),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists kyc_sessions_user_created_idx
  on public.kyc_sessions (user_id, created_at desc);
alter table public.kyc_sessions enable row level security;
revoke all on public.kyc_sessions from public, anon, authenticated;
grant select on public.kyc_sessions to authenticated;
grant all on public.kyc_sessions to service_role;
do $$
declare
  pol record;
begin
  for pol in
    select policyname from pg_policies
     where schemaname = 'public' and tablename = 'kyc_sessions'
  loop
    execute format('drop policy %I on public.kyc_sessions', pol.policyname);
  end loop;
end $$;
create policy "Users read own KYC sessions"
  on public.kyc_sessions
  for select
  to authenticated
  using ((select auth.uid()) = user_id);
create or replace function public.set_kyc_sessions_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
drop trigger if exists trg_kyc_sessions_updated on public.kyc_sessions;
create trigger trg_kyc_sessions_updated
  before update on public.kyc_sessions
  for each row execute function public.set_kyc_sessions_updated_at();

-- 20261108075723_idswyft_kyc_status_details.sql
alter table public.kyc_sessions
  add column if not exists current_step smallint not null default 1,
  add column if not exists ocr_data jsonb,
  add column if not exists liveness_results jsonb,
  add column if not exists cross_validation_results jsonb,
  add column if not exists rejection_reason text;
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.kyc_sessions'::regclass
      and conname = 'kyc_sessions_current_step_check'
  ) then
    alter table public.kyc_sessions
      add constraint kyc_sessions_current_step_check check (current_step between 1 and 5);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.kyc_sessions'::regclass
      and conname = 'kyc_sessions_ocr_data_object_check'
  ) then
    alter table public.kyc_sessions
      add constraint kyc_sessions_ocr_data_object_check
      check (ocr_data is null or jsonb_typeof(ocr_data) = 'object');
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.kyc_sessions'::regclass
      and conname = 'kyc_sessions_liveness_results_object_check'
  ) then
    alter table public.kyc_sessions
      add constraint kyc_sessions_liveness_results_object_check
      check (liveness_results is null or jsonb_typeof(liveness_results) = 'object');
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.kyc_sessions'::regclass
      and conname = 'kyc_sessions_cross_validation_results_object_check'
  ) then
    alter table public.kyc_sessions
      add constraint kyc_sessions_cross_validation_results_object_check
      check (cross_validation_results is null or jsonb_typeof(cross_validation_results) = 'object');
  end if;
end;
$$;
update public.kyc_sessions
   set current_step = case status
     when 'AWAITING_FRONT' then 2
     when 'AWAITING_BACK' then 3
     when 'AWAITING_LIVE' then 4
     else 5
   end,
       ocr_data = metadata -> 'ocr',
       liveness_results = metadata -> 'liveness',
       cross_validation_results = metadata -> 'cross_validation'
 where current_step = 1
    or ocr_data is null
    or liveness_results is null
    or cross_validation_results is null;

-- 20261123140000_retire_client_identity_approval.sql
-- Client-trusted instant approval is retired: neither the instant self-approval
-- RPC nor the KYC-driven approver exists any more, and any approved instant row
-- is rejected so a verified badge requires review_identity_verification.
update public.identity_verifications
   set status = 'rejected',
       reviewer_note = 'Instant self-approval is no longer accepted. Submit a government ID for admin review.',
       reviewed_by = null,
       reviewed_at = null,
       updated_at = now()
 where tier = 'instant'
   and status = 'approved'
   and reviewed_by is null;

-- ===========================================================================
-- Workflow session management
-- ===========================================================================
-- Server-only QA/vault roles, expiring vault approvals, isolated workflow
-- sessions, one-time CLI handoffs, and audit events. All six tables are written
-- only by service_role through manage_workflow_session; the RPC bodies are split
-- so 20261123103000 can route issue_cli_handoff to a dedicated function while
-- preserving the original dispatcher as manage_workflow_session_legacy.
--   from 20261123090121_workflow_session_management.sql
--   from 20261123103000_workflow_cli_handoff_dispatch.sql

create table if not exists public.workflow_session_roles (
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('qa', 'vault_operator')),
  active boolean not null default true,
  granted_by uuid not null references auth.users(id),
  granted_at timestamptz not null default now(),
  primary key (user_id, role)
);
create table if not exists public.workflow_session_approvals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  approved_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  constraint workflow_session_approvals_expiry_check
    check (expires_at > created_at and expires_at <= created_at + interval '5 minutes')
);
create table if not exists public.workflow_sessions (
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
create table if not exists public.workflow_session_handoffs (
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
create table if not exists public.workflow_cli_sessions (
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
create table if not exists public.workflow_session_audit (
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

create index if not exists workflow_session_roles_active_idx
  on public.workflow_session_roles (user_id, role) where active;
create index if not exists workflow_session_approvals_pending_idx
  on public.workflow_session_approvals (user_id, expires_at)
  where consumed_at is null;
create index if not exists workflow_sessions_owner_kind_idx
  on public.workflow_sessions (user_id, kind, expires_at);
create index if not exists workflow_session_handoffs_expiry_idx
  on public.workflow_session_handoffs (expires_at)
  where consumed_at is null;
create index if not exists workflow_cli_sessions_parent_idx
  on public.workflow_cli_sessions (workflow_session_id, expires_at);
create unique index if not exists workflow_sessions_one_active_per_kind_idx
  on public.workflow_sessions (user_id, kind) where status = 'active';
create index if not exists workflow_session_audit_created_at_idx
  on public.workflow_session_audit (created_at desc);
create index if not exists workflow_session_audit_subject_idx
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

-- The original dispatcher body, renamed to make room for the CLI-handoff router.
create or replace function public.manage_workflow_session_legacy(
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

revoke all on function public.manage_workflow_session_legacy(uuid, text, text, uuid, text, uuid, text, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.manage_workflow_session_legacy(uuid, text, text, uuid, text, uuid, text, uuid, uuid, text)
  to service_role;

-- Dedicated handoff issuer (20261123103000_workflow_cli_handoff_dispatch.sql).
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

-- Router that sends issue_cli_handoff to the dedicated function and everything
-- else to the legacy dispatcher.
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

revoke all on function public.manage_workflow_session(uuid, text, text, uuid, text, uuid, text, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.manage_workflow_session(uuid, text, text, uuid, text, uuid, text, uuid, uuid, text)
  to service_role;
