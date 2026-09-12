-- Run as postgres in a DEVELOPMENT Supabase project after both migrations.
-- This uses synthetic credentials and rolls back every change.
begin;
insert into auth.users(id) values
  ('a11d0000-0000-4000-8000-000000000011'),
  ('a11d0000-0000-4000-8000-000000000012');
set local request.method = 'POST';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a11d0000-0000-4000-8000-000000000011', true);
select set_config('request.jwt.claims', '{"sub":"a11d0000-0000-4000-8000-000000000011","role":"authenticated"}', true);

do $$
declare result jsonb; connection_id text;
begin
  result := public.anydownload_external_integrations('{"action":"save","provider":"immich","serverUrl":"http://192.168.0.103:2283","apiKey":"synthetic-owner-A"}');
  if result ? 'error' then raise exception 'Save failed: %', result; end if;
  connection_id := result #>> '{connection,id}';
  perform set_config('anydownload.test_connection', connection_id, true);
  if result::text like '%synthetic%' or result::text like '%secret%' then raise exception 'Save leaked credential'; end if;
  result := public.anydownload_external_integrations('{"action":"list"}');
  if jsonb_array_length(result -> 'connections') <> 1 or result::text like '%synthetic%' or result::text like '%secret%' then
    raise exception 'List is wrong or leaked a credential';
  end if;
  result := public.anydownload_external_integrations(jsonb_build_object('action', 'credential', 'connectionId', connection_id));
  if result ->> 'apiKey' <> 'synthetic-owner-A' then raise exception 'Owner credential retrieval failed'; end if;
  if current_setting('response.headers')::jsonb <> '[{"Cache-Control":"no-store"},{"Pragma":"no-cache"}]'::jsonb then
    raise exception 'Credential retrieval lacks no-store';
  end if;
  perform public.anydownload_external_integrations(jsonb_build_object('action', 'defaultAlbum', 'connectionId', connection_id,
    'defaultAlbumId', 'a11d0000-0000-4000-8000-000000000020'));
  if (select default_album_id from public.anydownload_connections) <> 'a11d0000-0000-4000-8000-000000000020' then
    raise exception 'Default album not stored';
  end if;
  result := public.anydownload_external_integrations(jsonb_build_object('action', 'save', 'connectionId', connection_id,
    'provider', 'immich', 'serverUrl', 'https://immich.tail-example.ts.net', 'apiKey', 'synthetic-replaced-A'));
  if not result ? 'error' then raise exception 'Connection origin changed'; end if;
  result := public.anydownload_external_integrations(jsonb_build_object('action', 'save', 'connectionId', connection_id,
    'provider', 'immich', 'serverUrl', 'http://192.168.0.103:2283', 'apiKey', 'synthetic-replaced-A'));
  if result #>> '{connection,serverUrl}' <> 'http://192.168.0.103:2283' or
    result #> '{connection,defaultAlbumId}' <> 'null'::jsonb then raise exception 'Explicit reconfiguration failed'; end if;
  result := public.anydownload_external_integrations(jsonb_build_object('action', 'credential', 'connectionId', connection_id));
  if result ->> 'apiKey' <> 'synthetic-replaced-A' then raise exception 'Replacement was not saved'; end if;
  if not (public.anydownload_external_integrations(jsonb_build_object('action', 'credential', 'connectionId', connection_id,
    'userId', 'a11d0000-0000-4000-8000-000000000012')) ? 'error') then raise exception 'Accepted client userId'; end if;
  if not (public.anydownload_external_integrations('{"action":"save","provider":"immich","serverUrl":"http://bad.test/?apiKey=key","apiKey":"synthetic"}') ? 'error') then
    raise exception 'Accepted a URL with credentials/query';
  end if;
  begin
    perform 1 from vault.decrypted_secrets;
    raise exception 'Owner can query Vault';
  exception when insufficient_privilege then null; end;
  begin
    perform 1 from anydownload_private.connection_secrets;
    raise exception 'Owner can query secret references';
  exception when insufficient_privilege then null; end;
  begin
    update public.anydownload_connections set server_url = 'http://attacker.test';
    raise exception 'Owner can change origin without reconfiguration';
  exception when insufficient_privilege then null; end;
end;
$$;

select set_config('request.jwt.claim.sub', 'a11d0000-0000-4000-8000-000000000012', true);
select set_config('request.jwt.claims', '{"sub":"a11d0000-0000-4000-8000-000000000012","role":"authenticated"}', true);
do $$
declare action text; request jsonb; result jsonb;
begin
  if exists(select 1 from public.anydownload_connections) then raise exception 'Cross-user metadata read'; end if;
  if public.anydownload_external_integrations('{"action":"list"}') <> '{"connections":[]}'::jsonb then
    raise exception 'Cross-user list';
  end if;
  foreach action in array array['credential', 'save', 'delete', 'defaultAlbum'] loop
    request := jsonb_build_object('action', action, 'connectionId', current_setting('anydownload.test_connection'));
    if action = 'save' then request := request || '{"provider":"immich","serverUrl":"http://attacker.test","apiKey":"synthetic-attacker"}'::jsonb; end if;
    if action = 'defaultAlbum' then request := request || '{"defaultAlbumId":null}'::jsonb; end if;
    result := public.anydownload_external_integrations(request);
    if result <> '{"error":"Connection not found."}'::jsonb then raise exception 'Cross-user % isolation failed', action; end if;
  end loop;
end;
$$;

set local role anon;
do $$
begin
  begin
    perform public.anydownload_external_integrations('{"action":"list"}');
    raise exception 'Anonymous RPC access';
  exception when insufficient_privilege then null; end;
  begin
    perform 1 from public.anydownload_connections;
    raise exception 'Anonymous metadata access';
  exception when insufficient_privilege then null; end;
  begin
    perform 1 from vault.decrypted_secrets;
    raise exception 'Anonymous Vault access';
  exception when insufficient_privilege then null; end;
end;
$$;

reset role;
do $$
declare secret_id uuid;
begin
  select s.secret_id into strict secret_id from anydownload_private.connection_secrets s
    where s.connection_id = current_setting('anydownload.test_connection')::uuid;
  perform set_config('anydownload.test_secret', secret_id::text, true);
  if (select secret from vault.secrets where id = secret_id) = 'synthetic-replaced-A' then
    raise exception 'Vault stored plaintext';
  end if;
  if (select count(*) from anydownload_private.connection_secrets where connection_id = current_setting('anydownload.test_connection')::uuid) <> 1 then
    raise exception 'Replacement left duplicate secret references';
  end if;
end;
$$;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a11d0000-0000-4000-8000-000000000011', true);
select set_config('request.jwt.claims', '{"sub":"a11d0000-0000-4000-8000-000000000011","role":"authenticated"}', true);
do $$
begin
  if public.anydownload_external_integrations(jsonb_build_object('action', 'delete', 'connectionId', current_setting('anydownload.test_connection'))) <> '{"deleted":true}'::jsonb then
    raise exception 'Disconnect failed';
  end if;
  if exists(select 1 from public.anydownload_connections) then raise exception 'Disconnect left metadata'; end if;
end;
$$;
reset role;
do $$
begin
  if exists(select 1 from vault.secrets where id = current_setting('anydownload.test_secret')::uuid) then raise exception 'Disconnect left secret'; end if;
end;
$$;

set local role authenticated;
do $$
declare result jsonb;
begin
  result := public.anydownload_external_integrations('{"action":"save","provider":"immich","serverUrl":"http://immich.test","apiKey":"synthetic-cascade"}');
  perform set_config('anydownload.test_connection', result #>> '{connection,id}', true);
  perform set_config('request.method', 'GET', true);
  if not (public.anydownload_external_integrations(jsonb_build_object('action', 'credential', 'connectionId', result #>> '{connection,id}')) ? 'error') then
    raise exception 'GET credential operation allowed';
  end if;
end;
$$;
reset role;
do $$
declare secret_id uuid;
begin
  select s.secret_id into strict secret_id from anydownload_private.connection_secrets s
    where s.connection_id = current_setting('anydownload.test_connection')::uuid;
  delete from auth.users where id = 'a11d0000-0000-4000-8000-000000000011';
  if exists(select 1 from vault.secrets where id = secret_id) then raise exception 'Account deletion left secret'; end if;
end;
$$;
rollback;
