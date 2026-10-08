-- Domínios próprios por lojamestre (ex.: pedidos.lojadojoao.com.br). Quem entra
-- por um desses endereços não vê o campo "Lojamestre" no login: ela já vem do
-- domínio. Sem RLS, como `tenants`: o login precisa ler antes de haver sessão.
-- O domínio fica guardado normalizado (minúsculo, sem "www.", porta ou caminho).
create table tenant_domains (
  id         bigint generated always as identity primary key,
  tenant_id  bigint not null references tenants (id) on delete cascade,
  domain     text not null,
  created_at timestamptz not null default now()
);
create unique index tenant_domains_domain_key on tenant_domains (lower(domain));
create index tenant_domains_tenant_idx on tenant_domains (tenant_id);
