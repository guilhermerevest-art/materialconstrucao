-- Tentativas de login com falha, por e-mail e IP. Fica no banco porque, na
-- Vercel, cada instância da função tem memória própria.
create table login_attempts (
  key      text primary key,
  failures integer not null,
  reset_at timestamptz not null
);
