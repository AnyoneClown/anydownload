-- Run against a development Supabase project AFTER the migration, as postgres.
-- Every test user and row is rolled back. No extension or real account is needed.
begin;

insert into auth.users (id) values
  ('a11d0000-0000-4000-8000-000000000001'),
  ('a11d0000-0000-4000-8000-000000000002');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'a11d0000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"a11d0000-0000-4000-8000-000000000001","role":"authenticated"}', true);

do $$
declare affected integer;
begin
  insert into public.anydownload_sync (user_id, payload)
    values ('a11d0000-0000-4000-8000-000000000001', '{"mediaLayout":"grid"}');
  begin
    insert into public.anydownload_sync (user_id, payload)
      values ('a11d0000-0000-4000-8000-000000000002', '{}');
    raise exception 'Cross-account insert unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;

  update public.anydownload_sync set payload = '{"mediaLayout":"list"}', revision = 2
    where user_id = 'a11d0000-0000-4000-8000-000000000001' and revision = 1;
  get diagnostics affected = row_count;
  if affected <> 1 then raise exception 'First CAS update failed'; end if;
  update public.anydownload_sync set payload = '{}', revision = 2
    where user_id = 'a11d0000-0000-4000-8000-000000000001' and revision = 1;
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'Stale CAS update overwrote new data'; end if;
  if (select payload from public.anydownload_sync) <> '{"mediaLayout":"list"}'::jsonb then
    raise exception 'CAS did not retain the winning payload';
  end if;
  begin
    update public.anydownload_sync set revision = 4;
    raise exception 'Skipped revision unexpectedly succeeded';
  exception when check_violation then null;
  end;
  begin
    update public.anydownload_sync set user_id = 'a11d0000-0000-4000-8000-000000000002';
    raise exception 'Owner mutation unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.anydownload_sync set updated_at = now();
    raise exception 'Timestamp mutation unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.anydownload_sync set revision = 3, payload = '{"accessToken":"secret"}';
    raise exception 'Unknown payload field unexpectedly succeeded';
  exception when check_violation then null;
  end;
  begin
    update public.anydownload_sync set revision = 3, payload = '[]';
    raise exception 'Invalid payload type unexpectedly succeeded';
  exception when check_violation then null;
  end;
  begin
    update public.anydownload_sync set revision = 3, payload = jsonb_build_object('filenameTemplate', repeat('x', 4194304));
    raise exception 'Oversized payload unexpectedly succeeded';
  exception when check_violation then null;
  end;
end;
$$;

select set_config('request.jwt.claim.sub', 'a11d0000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"a11d0000-0000-4000-8000-000000000002","role":"authenticated"}', true);

do $$
declare affected integer;
begin
  if exists (select 1 from public.anydownload_sync) then raise exception 'Another account can read the first account'; end if;
  update public.anydownload_sync set revision = 3, payload = '{}'
    where user_id = 'a11d0000-0000-4000-8000-000000000001';
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'Another account can update the first account'; end if;
  insert into public.anydownload_sync (user_id, payload)
    values ('a11d0000-0000-4000-8000-000000000002', '{}');
end;
$$;

set local role anon;
do $$
begin
  begin
    perform 1 from public.anydownload_sync;
    raise exception 'Anonymous read unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.anydownload_sync (user_id, payload)
      values ('a11d0000-0000-4000-8000-000000000002', '{}');
    raise exception 'Anonymous write unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
end;
$$;

rollback;
