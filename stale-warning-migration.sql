alter table public.push_subscriptions add column if not exists stale_warning_keys jsonb not null default '{}'::jsonb;
