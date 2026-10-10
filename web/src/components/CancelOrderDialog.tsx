import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { formatOrderNumber } from '@/lib/format';
import type { Order } from '@/lib/types';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Field, Textarea } from './ui/input';
import { Alert } from './ui/misc';

const QUOTE_REASONS = ['Preço', 'Prazo de entrega', 'Comprou em outro lugar', 'Desistiu da obra', 'Sem resposta do cliente'];
const ORDER_REASONS = ['Cliente desistiu', 'Pedido em duplicidade', 'Erro no lançamento', 'Falta de produto'];

/** Cancela o pedido ou marca o orçamento como perdido, pedindo o motivo. */
export function CancelOrderDialog({
  order,
  open,
  onOpenChange,
  onCancelled,
}: {
  order: Pick<Order, 'id' | 'status'>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCancelled: (order: Order) => void;
}) {
  const queryClient = useQueryClient();
  const isQuote = order.status === 'quote';
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setReason('');
    setError(null);
  }, [open]);

  const cancel = useMutation({
    mutationFn: () => api<{ order: Order }>(`/orders/${order.id}/cancel`, { method: 'POST', body: { reason } }),
    onSuccess: ({ order: next }) => {
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['monitor'] });
      queryClient.invalidateQueries({ queryKey: ['followups'] });
      queryClient.invalidateQueries({ queryKey: ['fiado'] });
      toast.success(isQuote ? 'Orçamento marcado como perdido.' : `Pedido nº ${formatOrderNumber(order.id)} cancelado.`);
      onCancelled(next);
      onOpenChange(false);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Não foi possível cancelar.'),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (reason.trim().length < 3) return setError('Informe o motivo.');
    cancel.mutate();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isQuote ? 'Marcar orçamento como perdido?' : `Cancelar o pedido nº ${formatOrderNumber(order.id)}?`}</DialogTitle>
          <DialogDescription>
            {isQuote
              ? 'O orçamento sai da lista de abertos e o motivo fica guardado. Dá para reabrir depois.'
              : 'O pedido sai do monitor e das vendas, mas continua no sistema com o motivo. Não dá para desfazer.'}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          {error && <Alert variant="danger" title={error} />}
          <div className="flex flex-wrap gap-2">
            {(isQuote ? QUOTE_REASONS : ORDER_REASONS).map((option) => (
              <Button key={option} type="button" variant="outline" size="sm" onClick={() => setReason(option)}>
                {option}
              </Button>
            ))}
          </div>
          <Field label="Motivo" htmlFor="cancelar-motivo">
            <Textarea
              id="cancelar-motivo"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={300}
              rows={3}
              autoFocus
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Voltar
            </Button>
            <Button type="submit" variant="destructive" loading={cancel.isPending}>
              {isQuote ? 'Marcar como perdido' : 'Cancelar pedido'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
