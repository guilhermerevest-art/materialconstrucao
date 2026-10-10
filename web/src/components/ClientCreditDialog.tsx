import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { decimalToInput, formatMoney, parseDecimal } from '@/lib/format';
import type { Client } from '@/lib/types';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Field, Input } from './ui/input';
import { Alert } from './ui/misc';

/** Limite do crediário do cliente. Só o administrador altera. */
export function ClientCreditDialog({
  client,
  open,
  onOpenChange,
}: {
  client: Client;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setText(client.credit_limit != null ? decimalToInput(client.credit_limit) : '');
    setError(null);
  }, [open, client.credit_limit]);

  const save = useMutation({
    mutationFn: (creditLimit: number | null) =>
      api(`/clients/${client.id}/credit`, { method: 'PUT', body: { credit_limit: creditLimit } }),
    onSuccess: (_, creditLimit) => {
      queryClient.invalidateQueries({ queryKey: ['clients'] });
      queryClient.invalidateQueries({ queryKey: ['client-credit', client.id] });
      toast.success(creditLimit === null ? `${client.name} não compra mais no crediário.` : `Limite de ${formatMoney(creditLimit)} salvo.`);
      onOpenChange(false);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Não foi possível salvar.'),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!text.trim()) return save.mutate(null);
    const value = parseDecimal(text);
    if (value === null) return setError('Digite o limite em reais, por exemplo 5.000,00.');
    save.mutate(value);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Crédito de {client.name}</DialogTitle>
          <DialogDescription>
            Quanto o cliente pode ficar devendo no crediário (parcelas em aberto, somando todas as lojas). Em branco, ele não
            compra no crediário.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          {error && <Alert variant="danger" title={error} />}
          <Field label="Limite de crédito (R$)" htmlFor="credito-limite">
            <Input id="credito-limite" inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} autoFocus placeholder="Sem crediário" />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" loading={save.isPending}>
              Salvar limite
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
