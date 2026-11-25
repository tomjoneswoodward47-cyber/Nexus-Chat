-- Retire client-trusted identity approval.
--
-- submit_instant_identity_verification accepted a browser face score and inserted
-- the caller's row as approved. approve_identity_from_kyc trusted
-- kyc_sessions.status, which the signed-in member could write. Neither path
-- remains. A verified badge now requires review_identity_verification.
-- A future provider must be checked on the server before any service-role write.

drop function if exists public.submit_instant_identity_verification(text, numeric);
drop function if exists public.approve_identity_from_kyc(uuid);
drop function if exists public.approve_identity_from_kyc(uuid);

update public.identity_verifications
   set status = 'rejected',
       reviewer_note = 'Instant self-approval is no longer accepted. Submit a government ID for admin review.',
       reviewed_by = null,
       reviewed_at = null,
       updated_at = now()
 where tier = 'instant'
   and status = 'approved'
   and reviewed_by is null;

do $$
declare
  pol record;
begin
  if to_regclass('public.kyc_sessions') is null then
    return;
  end if;

  for pol in
    select policyname
      from pg_policies
     where schemaname = 'public'
       and tablename = 'kyc_sessions'
  loop
    execute format('drop policy %I on public.kyc_sessions', pol.policyname);
  end loop;

  create policy "Users read own KYC sessions"
    on public.kyc_sessions
    for select
    to authenticated
    using ((select auth.uid()) = user_id);

  revoke all on public.kyc_sessions from public, anon, authenticated;
  grant select on public.kyc_sessions to authenticated;
end $$;
