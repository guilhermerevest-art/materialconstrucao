import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { formatDay, formatMoney, moneyToInput, parseDecimal } from '@/lib/format';
import { useUser } from '@/lib/auth';
import type { Client, ClientCredit } from '@/lib/types';
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
  const user = useUser();
  const credit = useQuery({
    queryKey: ['client-credit', client.id],
    queryFn: () => api<{ credit: ClientCredit }>(`/clients/${client.id}/credit`).then((r) => r.credit),
    enabled: open && Boolean(user.finance_enabled || user.fiado_enabled),
  });
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setText(client.credit_limit != null ? moneyToInput(client.credit_limit) : '');
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
            Quanto o cliente pode ficar devendo no crediário e no fiado, somando todas as lojas. Em branco, ele não compra a
            prazo.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          {error && <Alert variant="danger" title={error} />}
          {credit.data && (
            <dl className="grid grid-cols-2 gap-1 rounded-md border border-border p-3 text-sm">
              {user.finance_enabled && (
                <>
                  <dt className="text-muted-foreground">Crediário em aberto</dt>
                  <dd className="text-right font-semibold tabular-nums">{formatMoney(credit.data.open_balance)}</dd>
                </>
              )}
              {user.fiado_enabled && (
                <>
                  <dt className="text-muted-foreground">Fiado</dt>
                  <dd className="text-right font-semibold tabular-nums">{formatMoney(credit.data.fiado_balance ?? 0)}</dd>
                </>
              )}
              {user.finance_enabled && (
                <>
                  <dt className="text-muted-foreground">Crediário vencido</dt>
                  <dd className={`text-right font-semibold tabular-nums ${credit.data.overdue_amount > 0 ? 'text-destructive' : ''}`}>
                    {formatMoney(credit.data.overdue_amount)}
                    {credit.data.oldest_overdue && <span className="block text-xs font-normal">desde {formatDay(credit.data.oldest_overdue)}</span>}
                  </dd>
                </>
              )}
              {credit.data.available !== null && (
                <>
                  <dt className="text-muted-foreground">Disponível</dt>
                  <dd className="text-right font-semibold text-success tabular-nums">{formatMoney(credit.data.available)}</dd>
                </>
              )}
            </dl>
          )}
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
