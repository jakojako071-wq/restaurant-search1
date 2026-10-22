create table if not exists public.restaurants (
  id text primary key,
  owner_id uuid references auth.users(id) on delete set null,
  approved boolean not null default true,
  name text not null,
  category text not null,
  tags text not null default '',
  address text not null,
  emergency_closed boolean not null default false,
  opening_time text not null default '',
  closing_time text not null default '',
  phone text not null default '未登録',
  budget text not null default '未設定',
  lat double precision not null default 0,
  lng double precision not null default 0,
  images text[] not null default '{}' check (cardinality(images) <= 10),
  description text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.restaurants
  add column if not exists updated_at timestamptz not null default now();
alter table public.restaurants
  add column if not exists approved boolean not null default true;
alter table public.restaurants
  alter column approved set default false;
create index if not exists restaurants_updated_at_idx
  on public.restaurants (updated_at);

create or replace function public.set_restaurant_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := pg_catalog.now();
  return new;
end;
$$;

revoke all on function public.set_restaurant_updated_at() from public, anon, authenticated;
drop trigger if exists restaurants_set_updated_at on public.restaurants;
create trigger restaurants_set_updated_at
  before update on public.restaurants
  for each row execute function public.set_restaurant_updated_at();

create or replace function public.protect_restaurant_approval()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.approved is distinct from old.approved
    and current_user not in ('postgres', 'service_role') then
    raise exception 'Only trusted approval functions can change restaurant approval status';
  end if;
  return new;
end;
$$;

revoke all on function public.protect_restaurant_approval() from public, anon, authenticated;
drop trigger if exists restaurants_protect_approval on public.restaurants;
create trigger restaurants_protect_approval
  before update of approved on public.restaurants
  for each row execute function public.protect_restaurant_approval();

create unique index if not exists restaurants_one_store_per_owner
  on public.restaurants (owner_id)
  where owner_id is not null;

create table if not exists public.restaurant_emergency_qr_tokens (
  restaurant_id text primary key references public.restaurants(id) on delete cascade,
  token_hash text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.restaurant_disaster_acknowledgements (
  restaurant_id text primary key references public.restaurants(id) on delete cascade,
  event_key text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.restaurant_disaster_incidents (
  restaurant_id text primary key references public.restaurants(id) on delete cascade,
  event_key text not null,
  updated_at timestamptz not null default now()
);

drop function if exists public.claim_restaurant_disaster_notifications(integer);
drop function if exists public.finish_restaurant_disaster_notification(text, text, boolean, text);

alter table public.restaurant_disaster_incidents
  drop column if exists notification_sent_at,
  drop column if exists notification_attempts,
  drop column if exists notification_next_attempt_at,
  drop column if exists notification_last_error;

create table if not exists public.disaster_monitor_status (
  id integer primary key check (id = 1),
  last_checked_at timestamptz not null,
  last_error text
);

alter table public.restaurant_disaster_acknowledgements enable row level security;
revoke all on table public.restaurant_disaster_acknowledgements from public, anon, authenticated;
grant select on public.restaurant_disaster_acknowledgements to anon, authenticated;

drop policy if exists "Disaster acknowledgements are publicly readable" on public.restaurant_disaster_acknowledgements;
create policy "Disaster acknowledgements are publicly readable"
  on public.restaurant_disaster_acknowledgements for select
  to anon, authenticated
  using (true);

alter table public.restaurant_disaster_incidents enable row level security;
revoke all on table public.restaurant_disaster_incidents from public, anon, authenticated;
grant select on public.restaurant_disaster_incidents to anon, authenticated;

drop policy if exists "Disaster incidents are publicly readable" on public.restaurant_disaster_incidents;
create policy "Disaster incidents are publicly readable"
  on public.restaurant_disaster_incidents for select
  to anon, authenticated
  using (true);

alter table public.disaster_monitor_status enable row level security;
revoke all on table public.disaster_monitor_status from public, anon, authenticated;
grant select on public.disaster_monitor_status to anon, authenticated;

drop policy if exists "Disaster monitor status is publicly readable" on public.disaster_monitor_status;
create policy "Disaster monitor status is publicly readable"
  on public.disaster_monitor_status for select
  to anon, authenticated
  using (true);

create table if not exists public.store_registration_qr_tokens (
  token_hash text primary key,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.store_registration_qr_tokens enable row level security;
grant insert (token_hash, expires_at) on public.store_registration_qr_tokens to authenticated;

drop policy if exists "Moderators can create store registration QR tokens" on public.store_registration_qr_tokens;
create policy "Moderators can create store registration QR tokens"
  on public.store_registration_qr_tokens for insert
  to authenticated
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'moderator');

alter table public.restaurant_emergency_qr_tokens enable row level security;
grant select (restaurant_id), insert (restaurant_id, token_hash, updated_at), update (restaurant_id, token_hash, updated_at)
  on public.restaurant_emergency_qr_tokens to authenticated;

drop policy if exists "Owners and moderators can view emergency QR records" on public.restaurant_emergency_qr_tokens;
create policy "Owners and moderators can view emergency QR records"
  on public.restaurant_emergency_qr_tokens for select
  to authenticated
  using (
    exists (
      select 1 from public.restaurants
      where restaurants.id = restaurant_emergency_qr_tokens.restaurant_id
        and (
          restaurants.owner_id = (select auth.uid())
          or (auth.jwt() -> 'app_metadata' ->> 'role') = 'moderator'
        )
    )
  );

drop policy if exists "Owners and moderators can create emergency QR records" on public.restaurant_emergency_qr_tokens;
create policy "Owners and moderators can create emergency QR records"
  on public.restaurant_emergency_qr_tokens for insert
  to authenticated
  with check (
    exists (
      select 1 from public.restaurants
      where restaurants.id = restaurant_emergency_qr_tokens.restaurant_id
        and (
          restaurants.owner_id = (select auth.uid())
          or (auth.jwt() -> 'app_metadata' ->> 'role') = 'moderator'
        )
    )
  );

drop policy if exists "Owners and moderators can rotate emergency QR records" on public.restaurant_emergency_qr_tokens;
create policy "Owners and moderators can rotate emergency QR records"
  on public.restaurant_emergency_qr_tokens for update
  to authenticated
  using (
    exists (
      select 1 from public.restaurants
      where restaurants.id = restaurant_emergency_qr_tokens.restaurant_id
        and (
          restaurants.owner_id = (select auth.uid())
          or (auth.jwt() -> 'app_metadata' ->> 'role') = 'moderator'
        )
    )
  )
  with check (
    exists (
      select 1 from public.restaurants
      where restaurants.id = restaurant_emergency_qr_tokens.restaurant_id
        and (
          restaurants.owner_id = (select auth.uid())
          or (auth.jwt() -> 'app_metadata' ->> 'role') = 'moderator'
        )
    )
  );

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

create or replace function public.close_restaurant_with_qr(p_token text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  matched_restaurant_id text;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    return false;
  end if;

  select restaurant_id into matched_restaurant_id
  from public.restaurant_emergency_qr_tokens
  where token_hash = pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(p_token, 'UTF8'), 'sha256'),
    'hex'
  );

  if matched_restaurant_id is null then
    return false;
  end if;

  update public.restaurants
  set emergency_closed = true
  where id = matched_restaurant_id;
  return found;
end;
$$;

revoke all on function public.close_restaurant_with_qr(text) from public;
grant execute on function public.close_restaurant_with_qr(text) to anon, authenticated;

create or replace function public.approve_restaurant(p_restaurant_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (auth.jwt() -> 'app_metadata' ->> 'role') is distinct from 'moderator' then
    raise exception 'Only moderators can approve restaurant registrations';
  end if;

  update public.restaurants
  set approved = true
  where id = p_restaurant_id
    and approved = false;
  return found;
end;
$$;

create or replace function public.approve_restaurant_with_qr(p_token text, p_restaurant_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  matched_token_hash text;
begin
  if auth.uid() is null or p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    return false;
  end if;

  matched_token_hash := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(p_token, 'UTF8'), 'sha256'),
    'hex'
  );
  perform 1
  from public.store_registration_qr_tokens
  where token_hash = matched_token_hash
    and used_at is null
    and expires_at > pg_catalog.now()
  for update;
  if not found then
    return false;
  end if;

  update public.restaurants
  set approved = true
  where id = p_restaurant_id
    and owner_id = auth.uid()
    and approved = false;
  if not found then
    return false;
  end if;

  update public.store_registration_qr_tokens
  set used_at = pg_catalog.now()
  where token_hash = matched_token_hash;
  return true;
end;
$$;

revoke all on function public.approve_restaurant(text) from public, anon;
revoke all on function public.approve_restaurant_with_qr(text, text) from public, anon;
grant execute on function public.approve_restaurant(text) to authenticated;
grant execute on function public.approve_restaurant_with_qr(text, text) to authenticated;

create or replace function public.acknowledge_restaurant_disaster(p_restaurant_id text, p_event_key text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  matched_owner_id uuid;
begin
  if auth.uid() is null or p_restaurant_id is null or p_event_key is null or pg_catalog.char_length(p_event_key) > 4000 then
    return false;
  end if;

  select owner_id into matched_owner_id
  from public.restaurants
  where id = p_restaurant_id and approved = true
  for update;
  if not found then
    return false;
  end if;

  if matched_owner_id is distinct from auth.uid()
    and (auth.jwt() -> 'app_metadata' ->> 'role') is distinct from 'moderator' then
    return false;
  end if;

  delete from public.restaurant_disaster_incidents
  where restaurant_id = p_restaurant_id and event_key = p_event_key;
  if not found then
    return false;
  end if;

  insert into public.restaurant_disaster_acknowledgements (restaurant_id, event_key)
  values (p_restaurant_id, p_event_key)
  on conflict (restaurant_id) do update
    set event_key = excluded.event_key,
        updated_at = pg_catalog.now();

  update public.restaurants
  set emergency_closed = false
  where id = p_restaurant_id;
  return true;
end;
$$;

revoke all on function public.acknowledge_restaurant_disaster(text, text) from public, anon;
grant execute on function public.acknowledge_restaurant_disaster(text, text) to authenticated;

create or replace function public.record_restaurant_disasters(
  p_incidents jsonb,
  p_clear_acknowledgements text[]
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  incident record;
  recorded_count integer := 0;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the disaster monitor can record incidents';
  end if;
  if pg_catalog.jsonb_typeof(p_incidents) is distinct from 'array' then
    raise exception 'Invalid disaster incident batch';
  end if;
  if pg_catalog.jsonb_array_length(p_incidents) > 5000 then
    raise exception 'Invalid disaster incident batch';
  end if;
  if coalesce(pg_catalog.array_length(p_clear_acknowledgements, 1), 0) > 5000 then
    raise exception 'Invalid acknowledgement reset batch';
  end if;

  delete from public.restaurant_disaster_acknowledgements
  where restaurant_id = any(p_clear_acknowledgements);

  for incident in
    select restaurant_id, event_key
    from pg_catalog.jsonb_to_recordset(p_incidents) as item_rows(restaurant_id text, event_key text)
  loop
    if incident.restaurant_id is null or incident.event_key is null
      or pg_catalog.char_length(incident.event_key) > 4000 then
      raise exception 'Invalid disaster incident';
    end if;

    perform 1 from public.restaurants
    where id = incident.restaurant_id and approved = true
    for update;
    if not found or exists (
      select 1 from public.restaurant_disaster_acknowledgements
      where restaurant_id = incident.restaurant_id
        and event_key = incident.event_key
    ) then
      continue;
    end if;

    insert into public.restaurant_disaster_incidents (restaurant_id, event_key)
    values (incident.restaurant_id, incident.event_key)
    on conflict (restaurant_id) do update
      set event_key = excluded.event_key,
          updated_at = pg_catalog.now()
      where public.restaurant_disaster_incidents.event_key is distinct from excluded.event_key;
    if found then
      recorded_count := recorded_count + 1;
    end if;
  end loop;

  return recorded_count;
end;
$$;

revoke all on function public.record_restaurant_disasters(jsonb, text[]) from public, anon, authenticated;
grant execute on function public.record_restaurant_disasters(jsonb, text[]) to service_role;

create table if not exists public.reviews (
  id uuid primary key default gen_random_uuid(),
  restaurant_id text not null references public.restaurants(id) on delete cascade,
  author text not null default 'ゲスト',
  rating integer check (rating is null or rating between 1 and 5),
  comment text not null check (char_length(trim(comment)) between 1 and 1000),
  created_at timestamptz not null default now()
);

create index if not exists reviews_created_at_idx
  on public.reviews (created_at desc);

create or replace function public.delete_my_account(p_delete_restaurant boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  requesting_user_id uuid := auth.uid();
begin
  if requesting_user_id is null then
    raise exception 'Authentication is required to delete an account';
  end if;

  if p_delete_restaurant then
    delete from public.restaurants
    where owner_id = requesting_user_id;
  end if;

  delete from auth.users
  where id = requesting_user_id;
  return found;
end;
$$;

revoke all on function public.delete_my_account(boolean) from public, anon;
grant execute on function public.delete_my_account(boolean) to authenticated;

alter table public.restaurants enable row level security;
alter table public.reviews enable row level security;
grant usage on schema public to anon, authenticated;
grant select on public.restaurants, public.reviews to anon, authenticated;
revoke insert, update, delete on public.restaurants from authenticated;
grant insert (id, owner_id, name, category, tags, address, emergency_closed, opening_time, closing_time, phone, budget, lat, lng, images, description)
  on public.restaurants to authenticated;
grant update (name, category, tags, address, emergency_closed, opening_time, closing_time, phone, budget, lat, lng, images, description)
  on public.restaurants to authenticated;
grant delete on public.restaurants to authenticated;
grant insert, delete on public.reviews to anon, authenticated;

drop policy if exists "Restaurants are publicly readable" on public.restaurants;
create policy "Restaurants are publicly readable"
  on public.restaurants for select
  to anon, authenticated
  using (
    approved = true
    or owner_id = (select auth.uid())
    or (auth.jwt() -> 'app_metadata' ->> 'role') = 'moderator'
  );

drop policy if exists "Owners and moderators can add restaurants" on public.restaurants;
create policy "Owners and moderators can add restaurants"
  on public.restaurants for insert
  to authenticated
  with check (
    approved = false
    and (
      owner_id = (select auth.uid())
      or (auth.jwt() -> 'app_metadata' ->> 'role') = 'moderator'
    )
  );

drop policy if exists "Owners and moderators can update restaurants" on public.restaurants;
create policy "Owners and moderators can update restaurants"
  on public.restaurants for update
  to authenticated
  using (
    owner_id = (select auth.uid())
    or (auth.jwt() -> 'app_metadata' ->> 'role') = 'moderator'
  )
  with check (
    owner_id = (select auth.uid())
    or (auth.jwt() -> 'app_metadata' ->> 'role') = 'moderator'
  );

drop policy if exists "Moderators can delete restaurants" on public.restaurants;
create policy "Moderators can delete restaurants"
  on public.restaurants for delete
  to authenticated
  using (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'moderator'
    or (owner_id = (select auth.uid()) and approved = false)
  );

drop policy if exists "Reviews are publicly readable" on public.reviews;
create policy "Reviews are publicly readable"
  on public.reviews for select
  to anon, authenticated
  using (
    exists (
      select 1 from public.restaurants
      where restaurants.id = reviews.restaurant_id
        and restaurants.approved = true
    )
    or (auth.jwt() -> 'app_metadata' ->> 'role') = 'moderator'
  );

drop policy if exists "Visitors can add reviews" on public.reviews;
create policy "Visitors can add reviews"
  on public.reviews for insert
  to anon, authenticated
  with check (
    char_length(trim(author)) between 1 and 40
    and char_length(trim(comment)) between 1 and 1000
    and (rating is null or rating between 1 and 5)
    and exists (
      select 1 from public.restaurants
      where restaurants.id = reviews.restaurant_id
        and restaurants.approved = true
    )
  );

drop policy if exists "Moderators can delete reviews" on public.reviews;
create policy "Moderators can delete reviews"
  on public.reviews for delete
  to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'moderator');

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'restaurant-images',
  'restaurant-images',
  true,
  5242880,
  array['image/jpeg']
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Restaurant images are publicly readable" on storage.objects;
create policy "Restaurant images are publicly readable"
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'restaurant-images');

create or replace function public.can_upload_restaurant_image(object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.restaurants
    where id = (storage.foldername(object_name))[1]
      and (
        owner_id = (select auth.uid())
        or (auth.jwt() -> 'app_metadata' ->> 'role') = 'moderator'
      )
  );
$$;

revoke all on function public.can_upload_restaurant_image(text) from public, anon;
grant execute on function public.can_upload_restaurant_image(text) to authenticated;

drop policy if exists "Owners and moderators can upload restaurant images" on storage.objects;
create policy "Owners and moderators can upload restaurant images"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'restaurant-images'
    and public.can_upload_restaurant_image(name)
  );

drop policy if exists "Owners and moderators can update restaurant images" on storage.objects;
create policy "Owners and moderators can update restaurant images"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'restaurant-images'
    and exists (
      select 1 from public.restaurants
      where restaurants.id = (storage.foldername(name))[1]
        and (
          restaurants.owner_id = (select auth.uid())
          or (auth.jwt() -> 'app_metadata' ->> 'role') = 'moderator'
        )
    )
  )
  with check (
    bucket_id = 'restaurant-images'
    and exists (
      select 1 from public.restaurants
      where restaurants.id = (storage.foldername(name))[1]
        and (
          restaurants.owner_id = (select auth.uid())
          or (auth.jwt() -> 'app_metadata' ->> 'role') = 'moderator'
        )
    )
  );

drop policy if exists "Owners and moderators can delete restaurant images" on storage.objects;
create policy "Owners and moderators can delete restaurant images"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'restaurant-images'
    and (
      (auth.jwt() -> 'app_metadata' ->> 'role') = 'moderator'
      or exists (
        select 1 from public.restaurants
        where restaurants.id = (storage.foldername(name))[1]
          and restaurants.owner_id = (select auth.uid())
      )
    )
  );

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'restaurants'
  ) then
    alter publication supabase_realtime add table public.restaurants;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'reviews'
  ) then
    alter publication supabase_realtime add table public.reviews;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'restaurant_disaster_acknowledgements'
  ) then
    alter publication supabase_realtime add table public.restaurant_disaster_acknowledgements;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'restaurant_disaster_incidents'
  ) then
    alter publication supabase_realtime add table public.restaurant_disaster_incidents;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'disaster_monitor_status'
  ) then
    alter publication supabase_realtime add table public.disaster_monitor_status;
  end if;
end;
$$;

create or replace function public.delete_stale_restaurants()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.restaurants
  where updated_at < pg_catalog.now() - interval '1 month';

  delete from public.store_registration_qr_tokens
  where expires_at < pg_catalog.now()
    or used_at < pg_catalog.now() - interval '30 days';
end;
$$;

revoke all on function public.delete_stale_restaurants() from public, anon, authenticated;

do $$
declare
  existing_job record;
begin
  for existing_job in
    select jobid from cron.job where jobname = 'delete-stale-restaurants'
  loop
    perform cron.unschedule(existing_job.jobid);
  end loop;

  perform cron.schedule(
    'delete-stale-restaurants',
    '0 3 * * *',
    'select public.delete_stale_restaurants();'
  );
end;
$$;

do $$
declare
  project_url text;
  cron_secret text;
  existing_job record;
begin
  if pg_catalog.to_regclass('vault.decrypted_secrets') is not null then
    execute 'select decrypted_secret from vault.decrypted_secrets where name = $1'
      into project_url using 'project_url';
    execute 'select decrypted_secret from vault.decrypted_secrets where name = $1'
      into cron_secret using 'disaster_cron_secret';
  end if;

  if project_url is not null and cron_secret is not null then
    for existing_job in
      select jobid from cron.job where jobname = 'refresh-disaster-status'
    loop
      perform cron.unschedule(existing_job.jobid);
    end loop;

    perform cron.schedule(
      'refresh-disaster-status',
      '*/5 * * * *',
      $job$
        select net.http_post(
          url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
            || '/functions/v1/refresh-disaster-status',
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'disaster_cron_secret')
          ),
          body := '{}'::jsonb,
          timeout_milliseconds := 30000
        );
      $job$
    );
  else
    raise notice 'Disaster monitor schedule skipped: add the project_url and disaster_cron_secret values to Supabase Vault, then rerun this schema.';
  end if;
end;
$$;

-- 訓練専用状態。実災害テーブルと分離する。
create table if not exists public.disaster_drill_state (
  id integer primary key check(id=1),
  active boolean not null default false,
  scope text not null default 'prefecture' check(scope in ('national','prefecture','city')),
  prefecture text not null default '',
  city text not null default '',
  kind text not null default '地震' check(kind in ('地震','津波','気象警報')),
  updated_at timestamptz not null default now()
);
alter table public.disaster_drill_state enable row level security;
grant select on public.disaster_drill_state to anon, authenticated;
drop policy if exists "Anyone can view drills" on public.disaster_drill_state;
create policy "Anyone can view drills" on public.disaster_drill_state for select to anon, authenticated using (true);
insert into public.disaster_drill_state(id) values(1) on conflict(id) do nothing;
create or replace function public.set_disaster_drill(
 p_active boolean, p_scope text, p_prefecture text, p_city text, p_kind text
) returns void language plpgsql security definer set search_path = '' as $$
begin
 if (auth.jwt() -> 'app_metadata' ->> 'role') is distinct from 'moderator' then
   raise exception 'Only moderators can manage disaster drills';
 end if;
 if p_scope not in ('national','prefecture','city') or p_kind not in ('地震','津波','気象警報')
    or length(coalesce(p_prefecture,'')) > 20 or length(coalesce(p_city,'')) > 80
    or (p_active and p_scope='city' and length(trim(coalesce(p_city,'')))=0) then
   raise exception 'Invalid drill settings';
 end if;
 insert into public.disaster_drill_state(id,active,scope,prefecture,city,kind,updated_at)
 values(1,p_active,p_scope,coalesce(p_prefecture,''),coalesce(p_city,''),p_kind,now())
 on conflict(id) do update set active=excluded.active,scope=excluded.scope,
 prefecture=excluded.prefecture,city=excluded.city,kind=excluded.kind,updated_at=now();
end; $$;
revoke all on function public.set_disaster_drill(boolean,text,text,text,text) from public,anon;
grant execute on function public.set_disaster_drill(boolean,text,text,text,text) to authenticated;


-- Web Push端末登録。直接書き込みは許可せず、Edge Functionの認証経由で管理。
create table if not exists public.push_subscriptions (
  endpoint text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  subscription jsonb not null,
  last_notification_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists push_subscriptions_user_idx on public.push_subscriptions(user_id);
alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from anon, authenticated;
-- Edge Functionだけがservice_roleで読み書きする。
