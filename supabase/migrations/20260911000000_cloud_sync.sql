-- Run once in the Supabase SQL editor, or apply with `supabase db push`.
create or replace function public.anydownload_valid_sync_payload(data jsonb)
returns boolean
language plpgsql immutable
set search_path = ''
as $$
declare
  item record;
  count integer := 0;
begin
  if data is null or jsonb_typeof(data) <> 'object' or octet_length(data::text) > 4194304 then
    return false;
  end if;
  for item in select key, value from jsonb_each(data) loop
    count := count + 1;
    if count > 10004 then return false; end if;
    if item.key = 'includeBackgrounds' then
      if jsonb_typeof(item.value) <> 'boolean' then return false; end if;
    elsif item.key = 'filenameTemplate' then
      if jsonb_typeof(item.value) <> 'string' or length(item.value #>> '{}') > 240 then return false; end if;
    elsif item.key = 'smartFilters' then
      if jsonb_typeof(item.value) <> 'object' then return false; end if;
    elsif item.key = 'mediaLayout' then
      if item.value not in ('"grid"'::jsonb, '"list"'::jsonb) then return false; end if;
    elsif item.key ~ '^ignoredImage:https?%3A%2F%2F[^:]+:(url|data):[1-9][0-9]{0,6}:[a-f0-9]{16}$' then
      if jsonb_typeof(item.value) <> 'number' then return false; end if;
      if item.value::numeric < 0 or item.value::numeric > 9007199254740991 or
        trunc(item.value::numeric) <> item.value::numeric then return false; end if;
    elsif item.key ~ '^ledger:https?%3A%2F%2F[^:]+:[a-f0-9]{16}$' then
      if jsonb_typeof(item.value) <> 'object' then return false; end if;
    else
      return false;
    end if;
  end loop;
  return true;
end;
$$;

create table if not exists public.anydownload_sync (
  user_id uuid primary key references auth.users(id) on delete cascade,
  revision bigint not null default 1 check (revision between 1 and 9007199254740991),
  payload jsonb not null default '{}'::jsonb check (public.anydownload_valid_sync_payload(payload)),
  updated_at timestamptz not null default now()
);

create or replace function public.anydownload_sync_revision()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.revision <> 1 then
      raise exception 'Initial sync revision must be 1' using errcode = '23514';
    end if;
  elsif new.user_id <> old.user_id or new.revision <> old.revision + 1 then
    raise exception 'Sync owner is immutable and revision must advance by one' using errcode = '23514';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists anydownload_sync_revision on public.anydownload_sync;
create trigger anydownload_sync_revision before insert or update on public.anydownload_sync
  for each row execute function public.anydownload_sync_revision();

alter table public.anydownload_sync enable row level security;
alter table public.anydownload_sync force row level security;

drop policy if exists anydownload_sync_select on public.anydownload_sync;
create policy anydownload_sync_select on public.anydownload_sync for select to authenticated
  using ((select auth.uid()) = user_id);
drop policy if exists anydownload_sync_insert on public.anydownload_sync;
create policy anydownload_sync_insert on public.anydownload_sync for insert to authenticated
  with check ((select auth.uid()) = user_id);
drop policy if exists anydownload_sync_update on public.anydownload_sync;
create policy anydownload_sync_update on public.anydownload_sync for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

revoke all on public.anydownload_sync from public, anon, authenticated;
grant select on public.anydownload_sync to authenticated;
grant insert (user_id, revision, payload), update (revision, payload) on public.anydownload_sync to authenticated;
revoke all on function public.anydownload_valid_sync_payload(jsonb) from public, anon;
grant execute on function public.anydownload_valid_sync_payload(jsonb) to authenticated;
revoke all on function public.anydownload_sync_revision() from public, anon, authenticated;
