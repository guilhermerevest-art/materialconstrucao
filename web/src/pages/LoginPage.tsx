import { useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate, useLocation } from 'react-router';
import { BrandMark } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { ApiError } from '@/lib/api';
import { useDomainTenant, useLogin } from '@/lib/auth';
import { useDocumentTitle } from '@/lib/hooks';

function AuthShell({ subtitle, children }: { subtitle: string; children: ReactNode }) {
  return (
    <div className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-3">
          <BrandMark className="size-10" />
          <div className="leading-tight">
            <p className="text-xl font-bold tracking-tight">Gestão de Loja</p>
            <p className="text-sm text-muted-foreground">{subtitle}</p>
          </div>
        </div>
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="tape h-2.5" aria-hidden />
          <div className="p-6">{children}</div>
        </div>
      </div>
    </div>
  );
}

export function LoginPage() {
  useDocumentTitle('Entrar');
  const navigate = useNavigate();
  const location = useLocation();
  const login = useLogin();
  // Num domínio próprio a lojamestre vem do endereço, e o campo some.
  const domainTenant = useDomainTenant();
  const askTenant = !domainTenant.data;
  const [tenantSlug, setTenantSlug] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const from = (location.state as { from?: string } | null)?.from ?? '/';

  function submit(event: FormEvent) {
    event.preventDefault();
    login.mutate(
      {
        ...(askTenant ? { tenant_slug: tenantSlug.trim().toLowerCase() } : {}),
        username: username.trim().toLowerCase(),
        password,
      },
      { onSuccess: () => navigate(from, { replace: true }) },
    );
  }

  const error = login.error instanceof ApiError ? login.error.message : login.error ? 'Não foi possível entrar.' : null;

  if (domainTenant.isPending) {
    return (
      <AuthShell subtitle="Pedidos e orçamentos">
        <div className="grid place-items-center py-10">
          <Spinner />
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell subtitle={domainTenant.data?.name ?? 'Pedidos e orçamentos da rede'}>
      <h1 className="text-lg font-semibold">Entrar</h1>
      <form onSubmit={submit} className="mt-5 grid gap-4">
        {error && <Alert variant="danger" title={error} />}
        {askTenant && (
          <Field label="Lojamestre" htmlFor="tenant">
            <Input
              id="tenant"
              type="text"
              autoComplete="organization"
              value={tenantSlug}
              onChange={(e) => setTenantSlug(e.target.value)}
              required
              autoFocus
              spellCheck={false}
            />
          </Field>
        )}
        <Field label="Usuário" htmlFor="username">
          <Input
            id="username"
            type="text"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            autoFocus={!askTenant}
            spellCheck={false}
          />
        </Field>
        <Field label="Senha" htmlFor="senha">
          <Input
            id="senha"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </Field>
        <Button type="submit" size="lg" loading={login.isPending} className="mt-1 w-full">
          Entrar
        </Button>
      </form>
    </AuthShell>
  );
}
        