import { ShieldCheck } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { formatPercent } from '@/lib/format';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { Field, Input } from '../ui/input';
import { Alert } from '../ui/misc';

export type DiscountApprovalRequest = { limit: number; requested: number };

/**
 * Desconto acima do limite de quem vende: quem pode liberar (admin ou usuário marcado)
 * digita o próprio usuário e senha no balcão. A senha vai só nesta requisição.
 */
export function DiscountApprovalDialog({
  request,
  error,
  loading,
  onConfirm,
  onCancel,
}: {
  request: DiscountApprovalRequest | null;
  error: string | null;
  loading: boolean;
  onConfirm: (approval: { username: string; password: string }) => void;
  onCancel: () => void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  useEffect(() => {
    if (request) setPassword('');
  }, [request]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!username.trim() || !password) return;
    onConfirm({ username: username.trim(), password });
  }

  return (
    <Dialog open={request !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="size-5 text-primary" aria-hidden />
            Liberar desconto
          </DialogTitle>
          {request && (
            <DialogDescription>
              Desconto de {formatPercent(request.requested)} passa do limite de {formatPercent(request.limit)}. Quem pode liberar
              digita o usuário e a senha dele.
            </DialogDescription>
          )}
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4" autoComplete="off">
          {error && <Alert variant="danger" title={error} />}
          <Field label="Usuário de quem libera" htmlFor="liberar-usuario">
            <Input id="liberar-usuario" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="off" />
          </Field>
          <Field label="Senha" htmlFor="liberar-senha">
            <Input
              id="liberar-senha"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel}>
              Voltar e mudar o desconto
            </Button>
            <Button type="submit" loading={loading} disabled={!username.trim() || !password}>
              Liberar e salvar
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
