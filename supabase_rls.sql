-- Execute no SQL Editor do Supabase (Settings → SQL Editor)
-- Habilita acesso público de leitura e escrita nas duas tabelas

alter table public.deck      enable row level security;
alter table public.deck_list enable row level security;

-- Política: qualquer pessoa pode ler
create policy "public read deck"
  on public.deck for select using (true);

create policy "public read deck_list"
  on public.deck_list for select using (true);

-- Política: qualquer pessoa pode inserir
create policy "public insert deck"
  on public.deck for insert with check (true);

create policy "public insert deck_list"
  on public.deck_list for insert with check (true);

-- Política: qualquer pessoa pode deletar
create policy "public delete deck"
  on public.deck for delete using (true);

create policy "public delete deck_list"
  on public.deck_list for delete using (true);
