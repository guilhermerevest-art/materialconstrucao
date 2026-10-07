import { useMutation } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Field, Input } from './ui/input';

export function ChangePasswordDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      api<void>('/auth/change-password', { method: 'POST', body: { current_password: current, new_password: next } }),
    onSuccess: () => {
      toast.success('Senha alterada. Outras sessões abertas foram encerradas.');
      close(false);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Não foi possível alterar a senha.'),
  });

  function close(nextOpen: boolean) {
    if (!nextOpen) {
      setCurrent('');
      setNext('');
      setConfirm('');
      setError(null);
    }
    onOpenChange(nextOpen);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (next.length < 8) return setError('A nova senha precisa ter pelo menos 8 caracteres.');
    if (next !== confirm) return setError('A confirmação não confere com a nova senha.');
    setError(null);
    mutation.mutate();
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Alterar senha</DialogTitle>
          <DialogDescription>Use pelo menos 8 caracteres.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          <Field label="Senha atual" htmlFor="senha-atual">
            <Input
              id="senha-atual"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              required
              autoFocus
            />
          </Field>
          <Field label="Nova senha" htmlFor="senha-nova">
            <Input
              id="senha-nova"
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              required
            />
          </Field>
          <Field label="Repita a nova senha" htmlFor="senha-confirma" error={error}>
            <Input
              id="senha-confirma"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => close(false)}>
              Cancelar
            </Button>
            <Button type="submit" loading={mutation.isPending}>
              Alterar senha
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
