-- Persist the byte size of a chat attachment so the message list can render a
-- compact file preview (type icon, file name, size) without a second lookup.
-- Nullable: non-attachment messages and rows created before this column simply
-- carry no size, and the UI omits the indicator when it is absent.
alter table public.messages add column if not exists file_size bigint;
