-- Tighten reads on the shared chat-files bucket.
--
-- The previous "Chat files signed-in read" policy granted every authenticated
-- member SELECT on every object in the bucket, and a legacy chat-member policy
-- allowed members to read objects outside their own folder. Recipients do not
-- read the object directly: uploads persist a signed URL on the message (or
-- feed post) and render that URL, and server-side services use the service-role
-- key. Narrowing SELECT to the owner folder (plus admins, for moderation)
-- therefore does not affect delivery.
--
-- Forward-only: drop the broad policy and replace it with an owner/admin scope,
-- mirroring the existing "ID docs own or admin read" policy.

drop policy if exists "Chat files signed-in read" on storage.objects;
drop policy if exists "Chat members read chat files" on storage.objects;

drop policy if exists "Chat files own or admin read" on storage.objects;
create policy "Chat files own or admin read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'chat-files'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.has_role(auth.uid(), 'admin'))
  );
