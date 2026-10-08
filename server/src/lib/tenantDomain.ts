import type { Db } from '../db/pool.js';

const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;

/**
 * Deixa o domínio no formato guardado em tenant_domains: minúsculo, sem
 * protocolo, caminho, porta, ponto final nem "www.". Devolve null se não for
 * um domínio válido. Serve tanto para o cadastro quanto para o Host da requisição.
 */
export function normalizeDomain(value: string): string | null {
  const domain = value
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .split(/[/?#]/)[0]!
    .replace(/:\d+$/, '')
    .replace(/\.$/, '')
    .replace(/^www\./, '');
  return DOMAIN_RE.test(domain) ? domain : null;
}

/** Lojamestre ligada ao domínio da requisição, ou null se o endereço não é de nenhuma. */
export async function findTenantByHost(db: Db, host: string | undefined) {
  const domain = host ? normalizeDomain(host) : null;
  if (!domain) return null;
  const { rows } = await db.query<{ id: number; slug: string; name: string; active: boolean }>(
    `select t.id, t.slug, t.name, t.active
       from tenant_domains d
       join tenants t on t.id = d.tenant_id
      where lower(d.domain) = $1`,
    [domain],
  );
  return rows[0] ?? null;
}
