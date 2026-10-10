import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { formatDay, formatMoney, formatOrderNumber, moneyToInput, parseDecimal } from '@/lib/format';
import type { PaymentMethod, Receivable } from '@/lib/types';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Field, Input, NativeSelect } from './ui/input';
import { Alert, Skeleton } from './ui/misc';

function PixCharge({ receivableId }: { receivableId: number }) {
  const pix = useQuery({
    queryKey: ['pix', receivableId],
    queryFn: () => api<{ amount: number; payload: string; qr: string }>(`/receivables/${receivableId}/pix`),
    retry: false,
  });
  if (pix.isPending) return <Skeleton className="h-40" />;
  if (pix.error) {
    return <Alert variant="info" title={pix.error instanceof ApiError ? pix.error.message : 'PIX indisponível.'} />;
  }
  return (
    <div className="flex flex-wrap items-center gap-4 rounded-md border border-border p-3">
      <img src={pix.data!.qr} alt="QR Code do PIX" className="size-36" />
      <div className="grid min-w-0 flex-1 gap-2 text-sm">
        <p>
          Cliente paga <strong>{formatMoney(pix.data!.amount)}</strong> lendo o QR Code no app do banco. Confira o crédito na conta antes
          de confirmar.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="justify-self-start"
          onClick={() => navigator.clipboard?.writeText(pix.data!.payload).then(() => toast.success('PIX copia e cola copiado.'))}
        >
          <Copy />
          Copiar PIX copia e cola
        </Button>
      </div>
    </div>
  );
}

/** Recebe uma parcela no caixa aberto: valor (pode ser parcial), forma, troco e PIX. */
export function ReceiveDialog({ receivable, onClose }: { receivable: Receivable; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [amountText, setAmountText] = useState(moneyToInput(receivable.remaining));
  const [methodId, setMethodId] = useState(receivable.payment_method_id ? String(receivable.payment_method_id) : '');
  const [givenText, setGivenText] = useState('');
  const [error, setError] = useState<{ text: string; cashClosed?: boolean } | null>(null);

  const methods = useQuery({
    queryKey: ['payment-methods'],
    queryFn: () => api<{ items: PaymentMethod[] }>('/payment-methods').then((r) => r.items),
  });
  // Crediário é como se vende, não como se paga.
  const options = (methods.data ?? []).filter((m) => m.active && m.kind !== 'store_credit');
  const method = options.find((m) => String(m.id) === methodId);

  useEffect(() => {
    if (methods.data && !options.some((m) => String(m.id) === methodId)) {
      setMethodId(String(options.find((m) => m.kind === 'cash')?.id ?? options[0]?.id ?? ''));
    }
    // Só quando as formas chegam.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [methods.data]);

  const amount = parseDecimal(amountText);
  const given = parseDecimal(givenText);
  const change = method?.kind === 'cash' && amount !== null && given !== null && given > amount ? given - amount : null;

  const receive = useMutation({
    mutationFn: () =>
      api(`/receivables/${receivable.id}/payments`, { method: 'POST', body: { amount, payment_method_id: Number(methodId) } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['receivables'] });
      queryClient.invalidateQueries({ queryKey: ['order-receivables'] });
      queryClient.invalidateQueries({ queryKey: ['cash'] });
      queryClient.invalidateQueries({ queryKey: ['client-credit'] });
      toast.success(change ? `Recebido. Troco: ${formatMoney(change)}.` : 'Recebido.');
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
    if (amount > receivable.remaining + 0.005) return setError({ text: `Falta só ${formatMoney(receivable.remaining)} desta parcela.` });
    if (!methodId) return setError({ text: 'Escolha a forma de pagamento.' });
    setError(null);
    receive.mutate();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Receber de {receivable.client_name}</DialogTitle>
          <DialogDescription>
            {receivable.order_id ? `Pedido ${formatOrderNumber(receivable.order_id)} · ` : ''}parcela {receivable.installment}/
            {receivable.installments} · vence {formatDay(receivable.due_date)} · falta {formatMoney(receivable.remaining)}
          </DialogDescription>
        </DialogHeader>
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
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Valor recebido" htmlFor="receber-valor" hint="Menos que o total: fica o restante em aberto.">
              <Input id="receber-valor" inputMode="decimal" value={amountText} onChange={(e) => setAmountText(e.target.value)} autoFocus />
            </Field>
            <Field label="Forma" htmlFor="receber-forma">
              <NativeSelect id="receber-forma" value={methodId} onChange={(e) => setMethodId(e.target.value)}>
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
              <Field label="Valor entregue pelo cliente" htmlFor="receber-entregue">
                <Input id="receber-entregue" inputMode="decimal" value={givenText} onChange={(e) => setGivenText(e.target.value)} placeholder="Para calcular o troco" />
              </Field>
              <p className="pb-2 text-lg font-semibold tabular-nums">{change !== null ? `Troco: ${formatMoney(change)}` : ''}</p>
            </div>
          )}
          {method?.kind === 'pix' && <PixCharge receivableId={receivable.id} />}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" loading={receive.isPending}>
              Confirmar recebimento
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
