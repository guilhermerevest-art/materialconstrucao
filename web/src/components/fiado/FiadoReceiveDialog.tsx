import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { useUser } from '@/lib/auth';
import { formatMoney, moneyToInput, parseDecimal } from '@/lib/format';
import type { FiadoAccount, PaymentMethod } from '@/lib/types';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { Checkbox, Field, Input, NativeSelect } from '../ui/input';
import { Alert, Skeleton } from '../ui/misc';

export const fiadoAccountKey = (clientId: number) => ['fiado', 'account', clientId];

/** Invalida tudo que mostra a conta do fiado. */
export function useInvalidateFiado() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: ['fiado'] });
    queryClient.invalidateQueries({ queryKey: ['cash'] });
    queryClient.invalidateQueries({ queryKey: ['client-credit'] });
  };
}

/**
 * Recebe do fiado: valor (parcial ou tudo), forma, troco no dinheiro e os encargos por
 * atraso (o admin pode dispensar). Com o financeiro ligado, entra no caixa aberto.
 */
export function FiadoReceiveDialog({ clientId, onClose }: { clientId: number; onClose: () => void }) {
  const user = useUser();
  const invalidate = useInvalidateFiado();
  const account = useQuery({
    queryKey: fiadoAccountKey(clientId),
    queryFn: () => api<FiadoAccount>(`/fiado/accounts/${clientId}`),
  });
  const methods = useQuery({
    queryKey: ['payment-methods'],
    queryFn: () => api<{ items: PaymentMethod[] }>('/payment-methods').then((r) => r.items),
  });
  // Fiado e crediário são formas de vender, não de pagar.
  const options = (methods.data ?? []).filter((m) => m.active && m.kind !== 'fiado' && m.kind !== 'store_credit');
  const [amountText, setAmountText] = useState('');
  const [methodId, setMethodId] = useState('');
  const [givenText, setGivenText] = useState('');
  const [waive, setWaive] = useState(false);
  const [error, setError] = useState<{ text: string; cashClosed?: boolean } | null>(null);

  const data = account.data;
  const charges = data && !waive ? data.account.charges : 0;
  const debt = data ? Math.round((Math.max(0, data.account.balance) + charges) * 100) / 100 : 0;

  // Valor sugerido: o vencido (com encargos); sem atraso, o saldo inteiro.
  useEffect(() => {
    if (!data || amountText) return;
    const suggested = data.account.overdue > 0 ? data.account.overdue + data.account.charges : data.account.balance;
    setAmountText(moneyToInput(Math.max(0, Math.round(suggested * 100) / 100)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);
  useEffect(() => {
    if (!methodId && options[0]) setMethodId(String((options.find((m) => m.kind === 'cash') ?? options[0]).id));
  }, [options, methodId]);

  const method = options.find((m) => String(m.id) === methodId);
  const amount = parseDecimal(amountText);
  const given = givenText.trim() ? parseDecimal(givenText) : null;
  const change = method?.kind === 'cash' && amount !== null && given !== null && given >= amount ? Math.round((given - amount) * 100) / 100 : null;

  const receive = useMutation({
    mutationFn: () =>
      api<{ receipt: { amount: number; charges: number; balance: number } }>(`/fiado/accounts/${clientId}/payments`, {
        method: 'POST',
        body: { amount, payment_method_id: Number(methodId), waive_charges: waive },
      }),
    onSuccess: ({ receipt }) => {
      invalidate();
      toast.success(
        `Recebido ${formatMoney(receipt.amount)}${change !== null && change > 0 ? `. Troco: ${formatMoney(change)}` : ''}. Saldo: ${formatMoney(receipt.balance)}.`,
      );
      onClose();
    },
    onError: (err) =>
      setError({
        text: err instanceof ApiError ? err.message : 'Não foi possível receber.',
        cashClosed: err instanceof ApiError && err.code === 'CASH_CLOSED',
      }),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (amount === null || amount <= 0) return setError({ text: 'Digite o valor recebido.' });
    if (amount > debt + 0.005) return setError({ text: `O cliente deve ${formatMoney(debt)}. O troco fica fora do recebimento.` });
    if (!methodId) return setError({ text: 'Escolha a forma de pagamento.' });
    setError(null);
    receive.mutate();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Receber fiado{data ? ` de ${data.client.name}` : ''}</DialogTitle>
          {data && (
            <DialogDescription>
              Deve {formatMoney(Math.max(0, data.account.balance))}
              {data.account.overdue > 0 && ` · ${formatMoney(data.account.overdue)} vencido há ${data.account.days_late} ${data.account.days_late === 1 ? 'dia' : 'dias'}`}
              . O pagamento abate as compras mais antigas.
            </DialogDescription>
          )}
        </DialogHeader>
        {account.isPending ? (
          <Skeleton className="h-40" />
        ) : (
          <form onSubmit={submit} className="grid gap-4">
            {error && (
              <Alert variant="danger" title={error.text}>
                {error.cashClosed && (
                  <Button asChild variant="outline" size="sm" className="mt-1 justify-self-start">
                    <Link to="/caixa">Abrir o caixa</Link>
                  </Button>
                )}
              </Alert>
            )}
            {data && data.account.charges > 0 && (
              <div className="grid gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
                <p>
                  Encargos por atraso (multa e juros): <strong className="tabular-nums">{formatMoney(data.account.charges)}</strong>
                  {waive ? ' dispensados.' : ', lançados junto com este recebimento.'}
                </p>
                {user.role === 'admin' && (
                  <label className="flex items-center gap-2">
                    <Checkbox checked={waive} onChange={(e) => setWaive(e.target.checked)} />
                    Dispensar os encargos
                  </label>
                )}
              </div>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Valor recebido" htmlFor="fiado-valor" hint={`Pode ser parte. Total devido: ${formatMoney(debt)}.`}>
                <Input id="fiado-valor" inputMode="decimal" value={amountText} onChange={(e) => setAmountText(e.target.value)} autoFocus />
              </Field>
              <Field label="Forma" htmlFor="fiado-forma">
                <NativeSelect id="fiado-forma" value={methodId} onChange={(e) => setMethodId(e.target.value)}>
                  {options.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            </div>
            {method?.kind === 'cash' && (
              <div className="grid items-end gap-4 sm:grid-cols-2">
                <Field label="Valor entregue pelo cliente" htmlFor="fiado-entregue">
                  <Input id="fiado-entregue" inputMode="decimal" value={givenText} onChange={(e) => setGivenText(e.target.value)} placeholder="Para calcular o troco" />
                </Field>
                <p className="pb-2 text-lg font-semibold tabular-nums">{change !== null ? `Troco: ${formatMoney(change)}` : ''}</p>
              </div>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancelar
              </Button>
              <Button type="submit" loading={receive.isPending}>
                Confirmar recebimento
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
