-- Credentials are separate from the general sync payload and public metadata.
create extension if not exists supabase_vault with schema vault;
create schema if not exists anydownload_private;
revoke all on schema anydownload_private from public, anon, authenticated;
revoke all on schema vault from public, anon, authenticated;
revoke all on all tables in schema vault from public, anon, authenticated;
revoke all on all functions in schema vault from public, anon, authenticated;

create table public.anydownload_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider = 'immich'),
  server_url text not null check (
    length(server_url) <= 2048 and
    server_url ~ '^https?://([A-Za-z0-9._-]+|\[[0-9A-Fa-f:]+\])(:[0-9]{1,5})?$'
  ),
  default_album_id uuid,
  unique (user_id, provider, server_url)
);
alter table public.anydownload_connections enable row level security;
alter table public.anydownload_connections force row level security;
create policy anydownload_connections_select on public.anydownload_connections
  for select to authenticated using ((select auth.uid()) = user_id);
revoke all on public.anydownload_connections from public, anon, authenticated;
grant select on public.anydownload_connections to authenticated;

create table anydownload_private.connection_secrets (
  connection_id uuid primary key references public.anydownload_connections(id) on delete cascade,
  secret_id uuid not null unique references vault.secrets(id)
);
alter table anydownload_private.connection_secrets enable row level security;
alter table anydownload_private.connection_secrets force row level security;
revoke all on anydownload_private.connection_secrets from public, anon, authenticated;

-- Also remove the encrypted secret when deleting an account cascades its rows.
create function anydownload_private.delete_connection_secret()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from vault.secrets where id = old.secret_id;
  return old;
end;
$$;
revoke all on function anydownload_private.delete_connection_secret() from public, anon, authenticated;
create trigger delete_connection_secret after delete on anydownload_private.connection_secrets
  for each row execute function anydownload_private.delete_connection_secret();

-- Only this bounded owner-authenticated operation can reach Vault. Its public
-- wrapper is an invoker; the privileged implementation stays outside Data API.
create function anydownload_private.external_integrations(request jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  owner_id uuid := auth.uid();
  action text := request ->> 'action';
  connection_id uuid;
  album_id uuid;
  secret_id uuid;
  api_key text;
  connection public.anydownload_connections;
  metadata jsonb;
begin
  perform set_config('response.headers', '[{"Cache-Control":"no-store"},{"Pragma":"no-cache"}]', true);
  if current_setting('request.method', true) is distinct from 'POST' then
    perform set_config('response.status', '405', true);
    return '{"error":"Use POST for integration requests."}'::jsonb;
  end if;
  if owner_id is null or not exists (select 1 from auth.users where id = owner_id) then
    perform set_config('response.status', '401', true);
    return '{"error":"Sign in to your AnyDownload account."}'::jsonb;
  end if;
  if request is null or jsonb_typeof(request) <> 'object' or octet_length(request::text) > 32768 or
    action is null or action not in ('list', 'save', 'credential', 'delete', 'defaultAlbum') or
    exists (select 1 from jsonb_object_keys(request) k where k not in
      ('action', 'connectionId', 'provider', 'serverUrl', 'apiKey', 'defaultAlbumId')) then
    raise invalid_parameter_value;
  end if;
  if action = 'list' then
    if request <> '{"action":"list"}'::jsonb then raise invalid_parameter_value; end if;
    return jsonb_build_object('connections', coalesce((
      select jsonb_agg(jsonb_build_object('id', id, 'provider', provider,
        'serverUrl', server_url, 'defaultAlbumId', default_album_id) order by id)
      from public.anydownload_connections where user_id = owner_id
    ), '[]'::jsonb));
  end if;

  if request ? 'connectionId' then
    if jsonb_typeof(request -> 'connectionId') <> 'string' or
      (request ->> 'connectionId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise invalid_parameter_value;
    end if;
    connection_id := (request ->> 'connectionId')::uuid;
  elsif action <> 'save' then
    raise invalid_parameter_value;
  end if;
  if action not in ('save', 'defaultAlbum') and request - 'action' - 'connectionId' <> '{}'::jsonb then
    raise invalid_parameter_value;
  end if;
  if action = 'defaultAlbum' and request - 'action' - 'connectionId' - 'defaultAlbumId' <> '{}'::jsonb then
    raise invalid_parameter_value;
  end if;
  if action in ('save', 'defaultAlbum') then
    if action = 'defaultAlbum' and not request ? 'defaultAlbumId' then raise invalid_parameter_value; end if;
    if request ? 'defaultAlbumId' and request -> 'defaultAlbumId' <> 'null'::jsonb then
      if jsonb_typeof(request -> 'defaultAlbumId') <> 'string' or
        (request ->> 'defaultAlbumId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise invalid_parameter_value;
      end if;
      album_id := (request ->> 'defaultAlbumId')::uuid;
    end if;
  end if;

  -- Serialize changes for one owner so the 20-connection bound cannot race.
  perform pg_advisory_xact_lock(hashtextextended(owner_id::text, 0));
  if connection_id is not null then
    select * into connection from public.anydownload_connections
      where id = connection_id and user_id = owner_id for update;
    if not found then
      perform set_config('response.status', '404', true);
      return '{"error":"Connection not found."}'::jsonb;
    end if;
  end if;
  if action = 'save' then
    api_key := request ->> 'apiKey';
    if request ->> 'provider' is distinct from 'immich' or
      jsonb_typeof(request -> 'serverUrl') is distinct from 'string' or
      length(request ->> 'serverUrl') > 2048 or
      (request ->> 'serverUrl') !~ '^https?://([A-Za-z0-9._-]+|\[[0-9A-Fa-f:]+\])(:[0-9]{1,5})?$' or
      jsonb_typeof(request -> 'apiKey') is distinct from 'string' or
      length(api_key) not between 1 and 4096 or api_key !~ '^[!-~]+$' then
      raise invalid_parameter_value;
    end if;
    if connection_id is null then
      if (select count(*) from public.anydownload_connections where user_id = owner_id) >= 20 then
        perform set_config('response.status', '400', true);
        return '{"error":"Disconnect an existing connection before adding another."}'::jsonb;
      end if;
      insert into public.anydownload_connections(user_id, provider, server_url, default_album_id)
        values (owner_id, 'immich', request ->> 'serverUrl', album_id) returning * into connection;
      secret_id := vault.create_secret(api_key);
      insert into anydownload_private.connection_secrets values (connection.id, secret_id);
    else
      if connection.server_url <> request ->> 'serverUrl' then
        perform set_config('response.status', '400', true);
        return '{"error":"Add a new connection to use a different server."}'::jsonb;
      end if;
      select s.secret_id into strict secret_id from anydownload_private.connection_secrets s
        where s.connection_id = connection.id;
      perform vault.update_secret(secret_id, api_key);
      update public.anydownload_connections set server_url = request ->> 'serverUrl', default_album_id = album_id
        where id = connection.id and user_id = owner_id returning * into connection;
    end if;
  elsif action = 'delete' then
    delete from public.anydownload_connections where id = connection.id and user_id = owner_id;
    return '{"deleted":true}'::jsonb;
  elsif action = 'defaultAlbum' then
    update public.anydownload_connections set default_album_id = album_id
      where id = connection.id and user_id = owner_id returning * into connection;
  end if;

  metadata := jsonb_build_object('id', connection.id, 'provider', connection.provider,
    'serverUrl', connection.server_url, 'defaultAlbumId', connection.default_album_id);
  if action = 'credential' then
    select v.decrypted_secret into strict api_key from vault.decrypted_secrets v
      join anydownload_private.connection_secrets s on s.secret_id = v.id
      where s.connection_id = connection.id;
    return jsonb_build_object('connection', metadata, 'apiKey', api_key);
  end if;
  return jsonb_build_object('connection', metadata);
exception
  when invalid_parameter_value or invalid_text_representation or check_violation or unique_violation then
    perform set_config('response.headers', '[{"Cache-Control":"no-store"},{"Pragma":"no-cache"}]', true);
    perform set_config('response.status', '400', true);
    return '{"error":"Invalid integration request or existing server connection."}'::jsonb;
  when others then
    -- Never propagate SQL details, request bodies, or Vault errors to clients/logs.
    perform set_config('response.headers', '[{"Cache-Control":"no-store"},{"Pragma":"no-cache"}]', true);
    perform set_config('response.status', '500', true);
    return '{"error":"Integration operation failed. Try again."}'::jsonb;
end;
$$;
revoke all on function anydownload_private.external_integrations(jsonb) from public, anon, authenticated;
grant usage on schema anydownload_private to authenticated;
grant execute on function anydownload_private.external_integrations(jsonb) to authenticated;

create function public.anydownload_external_integrations(request jsonb)
returns jsonb language sql security invoker set search_path = '' as $$
  select anydownload_private.external_integrations(request);
$$;
revoke all on function public.anydownload_external_integrations(jsonb) from public, anon, authenticated;
grant execute on function public.anydownload_external_integrations(jsonb) to authenticated;
