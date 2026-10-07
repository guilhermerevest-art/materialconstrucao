import { ArrowLeft } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { BrandMark } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { Alert } from '@/components/ui/misc';
import { ApiError } from '@/lib/api';
import { useLogin } from '@/lib/auth';
import { useDocumentTitle } from '@/lib/hooks';

function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-3">
          <BrandMark className="size-10" />
          <div className="leading-tight">
            <p className="text-xl font-bold tracking-tight">Balcão</p>
            <p className="text-sm text-muted-foreground">Pedidos e orçamentos da rede</p>
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
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const from = (location.state as { from?: string } | null)?.from ?? '/';

  function submit(event: FormEvent) {
    event.preventDefault();
    login.mutate({ email, password }, { onSuccess: () => navigate(from, { replace: true }) });
  }

  const error = login.error instanceof ApiError ? login.error.message : login.error ? 'Não foi possível entrar.' : null;

  return (
    <AuthShell>
      <h1 className="text-lg font-semibold">Entrar</h1>
      <form onSubmit={submit} className="mt-5 grid gap-4">
        {error && <Alert variant="danger" title={error} />}
        <Field label="E-mail" htmlFor="email">
          <Input
            id="email"
            type="email"
            autoComplete="username"
            inputMode="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
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
        <Link to="/esqueci-senha" className="justify-self-center text-sm font-medium text-primary hover:underline">
          Esqueci minha senha
        </Link>
      </form>
    </AuthShell>
  );
}

export function ForgotPasswordPage() {
  useDocumentTitle('Esqueci minha senha');
  return (
    <AuthShell>
      <h1 className="text-lg font-semibold">Esqueci minha senha</h1>
      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
        Peça ao administrador da rede para definir uma nova senha para você. Ele faz isso em Administração, na tela de
        Vendedores. Depois de entrar, troque a senha em <strong className="text-foreground">Alterar senha</strong>, no
        menu com o seu nome.
      </p>
      <Button asChild variant="outline" className="mt-6 w-full">
        <Link to="/login">
          <ArrowLeft />
          Voltar para o login
        </Link>
      </Button>
    </AuthShell>
  );
}
