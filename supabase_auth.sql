-- ════════════════════════════════════════════════════════════
-- Execute no SQL Editor do Supabase
-- ════════════════════════════════════════════════════════════

-- 1. Adiciona user_id às tabelas
alter table public.deck      add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table public.deck_list add column if not exists user_id uuid references auth.users(id) on delete cascade;

-- 2. Remove políticas antigas (públicas)
drop policy if exists "public read deck"        on public.deck;
drop policy if exists "public insert deck"      on public.deck;
drop policy if exists "public delete deck"      on public.deck;
drop policy if exists "public read deck_list"   on public.deck_list;
drop policy if exists "public insert deck_list" on public.deck_list;
drop policy if exists "public delete deck_list" on public.deck_list;

-- 3. Garante RLS ativo
alter table public.deck      enable row level security;
alter table public.deck_list enable row level security;

-- 4. Políticas por usuário autenticado
create policy "owner select deck"
  on public.deck for select
  using (auth.uid() = user_id);

create policy "owner insert deck"
  on public.deck for insert
  with check (auth.uid() = user_id);

create policy "owner delete deck"
  on public.deck for delete
  using (auth.uid() = user_id);

create policy "owner update deck"
  on public.deck for update
  using (auth.uid() = user_id);

create policy "owner select deck_list"
  on public.deck_list for select
  using (auth.uid() = user_id);

create policy "owner insert deck_list"
  on public.deck_list for insert
  with check (auth.uid() = user_id);

create policy "owner delete deck_list"
  on public.deck_list for delete
  using (auth.uid() = user_id);
