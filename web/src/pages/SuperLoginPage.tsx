import { useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { BrandMark } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { Alert } from '@/components/ui/misc';
import { ApiError } from '@/lib/api';
import { useDocumentTitle } from '@/lib/hooks';
import { useSuperLogin } from '@/lib/superAuth';

function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-3">
          <BrandMark className="size-10" />
          <div className="leading-tight">
            <p className="text-xl font-bold tracking-tight">Gestão de Loja · Super</p>
            <p className="text-sm text-muted-foreground">Painel do revendedor</p>
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

export function SuperLoginPage() {
  useDocumentTitle('Super · Entrar');
  const navigate = useNavigate();
  const login = useSuperLogin();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  function submit(event: FormEvent) {
    event.preventDefault();
    login.mutate(
      { email: email.trim().toLowerCase(), password },
      { onSuccess: () => navigate('/super', { replace: true }) },
    );
  }

  const error =
    login.error instanceof ApiError
      ? login.error.message
      : login.error
        ? 'Não foi possível entrar.'
        : null;

  return (
    <AuthShell>
      <h1 className="text-lg font-semibold">Entrar no painel do super admin</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Crie e gerencie as lojamestres da rede.
      </p>
      <form onSubmit={submit} className="mt-5 grid gap-4">
        {error && <Alert variant="danger" title={error} />}
        <Field label="E-mail" htmlFor="super-email">
          <Input
            id="super-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
            spellCheck={false}
          />
        </Field>
        <Field label="Senha" htmlFor="super-senha">
          <Input
            id="super-senha"
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