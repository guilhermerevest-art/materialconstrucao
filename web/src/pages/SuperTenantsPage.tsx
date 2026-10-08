import { useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { BrandMark, EmptyState, PageHeader } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Textarea } from '@/components/ui/input';
import { Alert, Badge, Skeleton } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { ApiError } from '@/lib/api';
import { useDocumentTitle } from '@/lib/hooks';
import {
  useCreateTenant,
  useMeSuper,
  useSuperLogout,
  useSuperTenants,
  useUpdateTenant,
} from '@/lib/superAuth';
import type { Tenant } from '@/lib/types';
import { cn } from '@/lib/utils';

/** Um domínio por linha (ou separados por vírgula/espaço). */
function parseDomains(text: string) {
  return text
    .split(/[\s,;]+/)
    .map((d) => d.trim())
    .filter(Boolean);
}

const DOMAINS_HINT =
  'Um por linha, ex.: pedidos.lojadojoao.com.br. Quem entrar por esses endereços não precisa informar a lojamestre. ' +
  'Cada domínio também precisa ser adicionado no projeto da Vercel.';

const SLUG_HINT = 'Digitado no login de quem entra pelo endereço geral, sem domínio próprio.';
const SLUG_ERROR = 'Slug: letras minúsculas, números e hífen. 2 a 32 caracteres.';

/** Slug normalizado, ou null se não estiver no formato aceito pelo servidor. */
function cleanSlug(value: string) {
  const slug = value.trim().toLowerCase();
  return /^[a-z0-9-]{2,32}$/.test(slug) ? slug : null;
}

function EditTenantDialog({ tenant, onOpenChange }: { tenant: Tenant | null; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const update = useUpdateTenant();
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [active, setActive] = useState(true);
  const [domains, setDomains] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!tenant) return;
    setSlug(tenant.slug);
    setName(tenant.name);
    setActive(tenant.active);
    setDomains(tenant.domains.join('\n'));
    setError(null);
  }, [tenant]);

  const slugChanged = tenant !== null && slug.trim().toLowerCase() !== tenant.slug;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!tenant) return;
    setError(null);
    const newSlug = cleanSlug(slug);
    if (!newSlug) return setError(SLUG_ERROR);
    update.mutate(
      { tenantId: tenant.id, slug: newSlug, name: name.trim(), active, domains: parseDomains(domains) },
      {
        onSuccess: ({ tenant: saved }) => {
          queryClient.invalidateQueries({ queryKey: ['super-tenants'] });
          toast.success(`Lojamestre "${saved.name}" atualizada.`);
          onOpenChange(false);
        },
        onError: (err) => setError(err instanceof ApiError ? err.message : 'Não foi possível salvar a lojamestre.'),
      },
    );
  }

  return (
    <Dialog open={tenant !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Editar lojamestre</DialogTitle>
          <DialogDescription>
            Os usuários, lojas e pedidos continuam como estão. Para mexer neles, entre como admin da lojamestre.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          {error && <Alert variant="danger" title={error} />}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Slug"
              htmlFor="tenant-edit-slug"
              hint={
                slugChanged
                  ? `Quem entra pelo endereço geral passa a digitar "${slug.trim().toLowerCase()}". Avise os usuários.`
                  : SLUG_HINT
              }
            >
              <Input
                id="tenant-edit-slug"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                autoComplete="off"
                required
                spellCheck={false}
              />
            </Field>
            <Field label="Nome" htmlFor="tenant-edit-name" hint="Como a lojamestre aparece no sistema.">
              <Input
                id="tenant-edit-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                autoFocus
              />
            </Field>
          </div>
          <Field label="Domínios" htmlFor="tenant-edit-domains" hint={DOMAINS_HINT}>
            <Textarea
              id="tenant-edit-domains"
              value={domains}
              onChange={(e) => setDomains(e.target.value)}
              rows={3}
              spellCheck={false}
            />
          </Field>
          <div className="grid gap-1.5">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={active} onChange={(e) => setActive(e.target.checked)} />
              Lojamestre ativa
            </label>
            {!active && (
              <p className="text-[13px] text-destructive">
                Ninguém desta lojamestre consegue entrar, e quem já está dentro é desconectado.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" loading={update.isPending}>
              Salvar lojamestre
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function NewTenantDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const create = useCreateTenant();
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [adminName, setAdminName] = useState('');
  const [adminUsername, setAdminUsername] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [domains, setDomains] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSlug('');
    setName('');
    setAdminName('');
    setAdminUsername('');
    setAdminPassword('');
    setAdminEmail('');
    setDomains('');
    setError(null);
  }, [open]);

  function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const newSlug = cleanSlug(slug);
    const cleanUsername = adminUsername.trim().toLowerCase();
    const cleanEmail = adminEmail.trim();
    if (!newSlug) return setError(SLUG_ERROR);
    if (!/^[a-z0-9._-]{3,32}$/.test(cleanUsername)) {
      return setError('Usuário do admin: letras, números, ponto, hífen ou underline. 3 a 32 caracteres.');
    }
    if (adminPassword.length < 8) {
      return setError('A senha provisória precisa ter pelo menos 8 caracteres.');
    }
    create.mutate(
      {
        slug: newSlug,
        name: name.trim(),
        admin_name: adminName.trim(),
        admin_username: cleanUsername,
        admin_password: adminPassword,
        ...(cleanEmail ? { admin_email: cleanEmail } : {}),
        domains: parseDomains(domains),
      },
      {
        onSuccess: ({ tenant, admin }) => {
          queryClient.invalidateQueries({ queryKey: ['super-tenants'] });
          toast.success(
            `Lojamestre "${tenant.name}" criada. Entre como ${admin.username} com a senha provisória.`,
          );
          onOpenChange(false);
        },
        onError: (err) =>
          setError(err instanceof ApiError ? err.message : 'Não foi possível criar a lojamestre.'),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nova lojamestre</DialogTitle>
          <DialogDescription>
            Cria um tenant isolado por RLS e o primeiro administrador. A senha provisória deve ser trocada
            no primeiro acesso.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          {error && <Alert variant="danger" title={error} />}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Slug"
              htmlFor="tenant-slug"
              hint={SLUG_HINT}
            >
              <Input
                id="tenant-slug"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                autoComplete="off"
                required
                autoFocus
                spellCheck={false}
              />
            </Field>
            <Field label="Nome" htmlFor="tenant-name" hint="Como a lojamestre aparece no sistema.">
              <Input
                id="tenant-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </Field>
          </div>
          <Field label="Nome do administrador" htmlFor="tenant-admin-name">
            <Input
              id="tenant-admin-name"
              value={adminName}
              onChange={(e) => setAdminName(e.target.value)}
              required
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Usuário" htmlFor="tenant-admin-username" hint="É o que ele digita para entrar.">
              <Input
                id="tenant-admin-username"
                value={adminUsername}
                onChange={(e) => setAdminUsername(e.target.value)}
                autoComplete="off"
                required
                spellCheck={false}
              />
            </Field>
            <Field label="E-mail (opcional)" htmlFor="tenant-admin-email">
              <Input
                id="tenant-admin-email"
                type="email"
                value={adminEmail}
                onChange={(e) => setAdminEmail(e.target.value)}
                autoComplete="off"
              />
            </Field>
          </div>
          <Field
            label="Senha provisória"
            htmlFor="tenant-admin-password"
            hint="Pelo menos 8 caracteres. Entregue ao cliente por um canal seguro."
          >
            <Input
              id="tenant-admin-password"
              type="password"
              autoComplete="new-password"
              value={adminPassword}
              onChange={(e) => setAdminPassword(e.target.value)}
              required
            />
          </Field>
          <Field label="Domínios (opcional)" htmlFor="tenant-domains" hint={DOMAINS_HINT}>
            <Textarea
              id="tenant-domains"
              value={domains}
              onChange={(e) => setDomains(e.target.value)}
              rows={2}
              spellCheck={false}
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" loading={create.isPending}>
              Criar lojamestre
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function SuperTenantsPage() {
  useDocumentTitle('Super · Lojamestres');
  const navigate = useNavigate();
  const me = useMeSuper();
  const tenants = useSuperTenants();
  const logout = useSuperLogout();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Tenant | null>(null);

  if (me.isPending) {
    return (
      <div className="grid min-h-dvh place-items-center">
        <Skeleton className="h-10 w-48" />
      </div>
    );
  }
  if (!me.data) return <Navigate to="/super/login" replace />;

  function handleLogout() {
    logout.mutate(undefined, { onSuccess: () => navigate('/super/login', { replace: true }) });
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-10">
      <header className="mb-8 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <BrandMark className="size-9" />
          <div className="leading-tight">
            <p className="text-lg font-bold tracking-tight">Painel do super admin</p>
            <p className="text-sm text-muted-foreground">{me.data.email}</p>
          </div>
        </div>
        <Button variant="outline" onClick={handleLogout} loading={logout.isPending}>
          Sair
        </Button>
      </header>

      <PageHeader
        title="Lojamestres"
        description="Cada lojamestre é um tenant isolado por RLS."
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus />
            Nova lojamestre
          </Button>
        }
      />

      <Card>
        {tenants.isPending ? (
          <div className="grid gap-2 p-4">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : tenants.isError ? (
          <div className="p-4">
            <Alert
              variant="danger"
              title="Não foi possível carregar as lojamestres."
            >
              {tenants.error instanceof ApiError ? tenants.error.message : 'Tente novamente em alguns instantes.'}
            </Alert>
          </div>
        ) : !tenants.data?.length ? (
          <EmptyState
            title="Nenhuma lojamestre ainda"
            description="Crie a primeira para liberar o login dos vendedores."
          />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH className="pl-4">Slug</TH>
                <TH>Nome</TH>
                <TH>Domínios</TH>
                <TH className="text-right">Lojas</TH>
                <TH className="text-right">Usuários</TH>
                <TH>Situação</TH>
                <TH>Criada em</TH>
                <TH className="pr-4" />
              </TR>
            </THead>
            <TBody>
              {tenants.data.map((tenant: Tenant) => (
                <TR key={tenant.id} className={cn(!tenant.active && 'text-muted-foreground')}>
                  <TD className="pl-4 font-mono text-[13px]">{tenant.slug}</TD>
                  <TD className="font-medium">{tenant.name}</TD>
                  <TD className="text-[13px]">
                    {tenant.domains.length ? (
                      tenant.domains.map((d) => <div key={d}>{d}</div>)
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TD>
                  <TD className="text-right tabular-nums">{tenant.stores_count}</TD>
                  <TD className="text-right tabular-nums">{tenant.users_count}</TD>
                  <TD>
                    <Badge variant={tenant.active ? 'success' : 'neutral'}>
                      {tenant.active ? 'Ativa' : 'Desativada'}
                    </Badge>
                  </TD>
                  <TD className="text-muted-foreground">{formatDate(tenant.created_at)}</TD>
                  <TD className="pr-4 text-right">
                    <Button size="sm" variant="outline" onClick={() => setEditing(tenant)}>
                      <Pencil />
                      Editar
                    </Button>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <NewTenantDialog open={creating} onOpenChange={setCreating} />
      <EditTenantDialog tenant={editing} onOpenChange={(open) => !open && setEditing(null)} />
    </div>
  );
}

function formatDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}