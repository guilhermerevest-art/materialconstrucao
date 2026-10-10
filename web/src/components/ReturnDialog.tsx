import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { decimalToInput, formatMoney, formatQuantity, parseDecimal } from '@/lib/format';
import type { Order, OrderReturnsView, RefundMethod } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Checkbox, Field, Input } from './ui/input';
import { Alert } from './ui/misc';
import { Table, TBody, TD, TH, THead, TR } from './ui/table';

const REASONS = ['Sobrou na obra', 'Troca por outro produto', 'Produto com defeito', 'Comprou errado'];

type Option = { value: RefundMethod; label: string; hint: string; disabled?: string };

/**
 * Devolução e troca: o que volta (até o que o cliente levou), se volta para a prateleira e
 * como o valor volta para ele. Troca = crédito para usar no pedido novo.
 */
export function ReturnDialog({ order, view, onClose }: { order: Order; view: OrderReturnsView; onClose: () => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const items = view.items.filter((i) => i.returnable > 0);
  const [quantities, setQuantities] = useState<Record<number, string>>({});
  const [restock, setRestock] = useState<Record<number, boolean>>({});
  const [reason, setReason] = useState('');
  const [method, setMethod] = useState<RefundMethod | null>(null);
  const [error, setError] = useState<{ text: string; cashClosed?: boolean } | null>(null);

  const lines = items.map((item) => {
    const qty = parseDecimal(quantities[item.order_item_id] ?? '') ?? 0;
    return { item, qty, amount: Math.round(qty * item.net_price * 100) / 100 };
  });
  const total = Math.round(lines.reduce((sum, l) => sum + l.amount, 0) * 100) / 100;
  const { options: opts } = view;

  const options: Option[] = [
    { value: 'credit', label: 'Crédito para troca', hint: 'Vira crédito do cliente (vale) para usar no pedido novo.' },
    {
      value: 'cash',
      label: 'Dinheiro',
      hint: opts.finance ? 'Sai da gaveta do seu caixa.' : 'Devolvido em dinheiro no balcão.',
      disabled: opts.finance && !opts.cash_open ? 'Abra o caixa para devolver em dinheiro.' : undefined,
    },
    { value: 'pix', label: 'PIX', hint: 'Estorno feito pelo app do banco.' },
    { value: 'card', label: 'Estorno no cartão', hint: 'Estorno feito na maquininha.' },
    ...(opts.fiado
      ? [{ value: 'fiado' as const, label: 'Abater no fiado', hint: 'Desconta do que o cliente deve na caderneta.' }]
      : []),
    ...(opts.finance && opts.open_receivables > 0
      ? [
          {
            value: 'receivables' as const,
            label: 'Abater nas parcelas',
            hint: `Desconta das parcelas em aberto deste pedido (${formatMoney(opts.open_receivables)}), da última para a primeira.`,
          },
        ]
      : []),
    { value: 'none', label: 'Sem devolver valor', hint: 'Só a mercadoria volta (ex.: garantia).' },
  ];

  const save = useMutation({
    mutationFn: () =>
      api<{ return: { id: number; amount: number } }>(`/orders/${order.id}/returns`, {
        method: 'POST',
        body: {
          reason,
          refund_method: method,
          items: lines
            .filter((l) => l.qty > 0)
            .map((l) => ({ order_item_id: l.item.order_item_id, quantity: l.qty, restock: restock[l.item.order_item_id] ?? true })),
        },
      }),
    onSuccess: ({ return: created }) => {
      queryClient.invalidateQueries({ queryKey: ['order-returns', order.id] });
      queryClient.invalidateQueries({ queryKey: ['stock'] });
      queryClient.invalidateQueries({ queryKey: ['cash'] });
      queryClient.invalidateQueries({ queryKey: ['fiado'] });
      queryClient.invalidateQueries({ queryKey: ['order-receivables', order.id] });
      queryClient.invalidateQueries({ queryKey: ['client-credits', order.client_id] });
      if (method === 'credit') {
        toast.success(`Crédito de ${formatMoney(created.amount)} para ${order.client_name}. Lance o pedido da troca.`);
        navigate(`/pedidos/novo?cliente=${order.client_id}`);
      } else {
        toast.success(`Devolução de ${formatMoney(created.amount)} registrada.`);
      }
      onClose();
    },
    onError: (err) =>
      setError({
        text: err instanceof ApiError ? err.message : 'Não foi possível registrar.',
        cashClosed: err instanceof ApiError && err.code === 'CASH_CLOSED',
      }),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const invalid = lines.find((l) => l.qty < 0 || l.qty > l.item.returnable + 0.0005 || (quantities[l.item.order_item_id]?.trim() && parseDecimal(quantities[l.item.order_item_id]!) === null));
    if (invalid) return setError({ text: `${invalid.item.product_name}: dá para devolver até ${formatQuantity(invalid.item.returnable)} ${invalid.item.unit}.` });
    if (!lines.some((l) => l.qty > 0)) return setError({ text: 'Informe a quantidade que volta.' });
    if (reason.trim().length < 3) return setError({ text: 'Informe o motivo da devolução.' });
    if (!method) return setError({ text: 'Escolha como o valor volta para o cliente.' });
    setError(null);
    save.mutate();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Devolução ou troca</DialogTitle>
          <DialogDescription>
            Volta só o que o cliente já levou. O valor considera o desconto do pedido.
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
          <div className="max-h-72 overflow-y-auto rounded-md border border-border">
            <Table>
              <THead>
                <TR>
                  <TH className="pl-3">Produto</TH>
                  <TH className="text-right">Pode voltar</TH>
                  <TH className="text-right">Volta</TH>
                  <TH className="pr-3 text-center">Estoque</TH>
                </TR>
              </THead>
              <TBody>
                {items.map((item) => (
                  <TR key={item.order_item_id}>
                    <TD className="pl-3">
                      {item.product_name}
                      <span className="block text-xs text-muted-foreground tabular-nums">{formatMoney(item.net_price)} / {item.unit}</span>
                    </TD>
                    <TD className="text-right whitespace-nowrap tabular-nums">
                      {formatQuantity(item.returnable)} {item.unit}
                      <button
                        type="button"
                        className="ml-2 text-xs font-medium text-primary hover:underline"
                        onClick={() => setQuantities((q) => ({ ...q, [item.order_item_id]: decimalToInput(item.returnable) }))}
                      >
                        Tudo
                      </button>
                    </TD>
                    <TD className="text-right">
                      <Input
                        aria-label={`Quantidade de ${item.product_name} que volta`}
                        inputMode="decimal"
                        value={quantities[item.order_item_id] ?? ''}
                        onChange={(e) => setQuantities((q) => ({ ...q, [item.order_item_id]: e.target.value }))}
                        placeholder="0"
                        className="ml-auto h-9 w-24 text-right tabular-nums"
                      />
                    </TD>
                    <TD className="pr-3 text-center">
                      <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" title="Desmarque se voltou avariado">
                        <Checkbox
                          checked={restock[item.order_item_id] ?? true}
                          onChange={(e) => setRestock((r) => ({ ...r, [item.order_item_id]: e.target.checked }))}
                          aria-label={`${item.product_name} volta para o estoque`}
                        />
                        volta
                      </label>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
          <p className="text-right text-sm">
            Valor da devolução: <strong className="text-base tabular-nums">{formatMoney(total)}</strong>
          </p>

          <Field label="Motivo" htmlFor="devolucao-motivo">
            <div className="grid gap-2">
              <div className="flex flex-wrap gap-1.5">
                {REASONS.map((r) => (
                  <Button key={r} type="button" variant="outline" size="sm" onClick={() => setReason(r)}>
                    {r}
                  </Button>
                ))}
              </div>
              <Input id="devolucao-motivo" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
            </div>
          </Field>

          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">Como o valor volta para o cliente</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {options.map((option) => (
                <label
                  key={option.value}
                  className={cn(
                    'flex cursor-pointer gap-2 rounded-md border px-3 py-2 text-sm',
                    method === option.value ? 'border-primary bg-primary-soft' : 'border-input hover:bg-muted',
                    option.disabled && 'cursor-not-allowed opacity-60',
                  )}
                >
                  <input
                    type="radio"
                    name="reembolso"
                    className="mt-0.5 accent-[var(--color-primary)]"
                    checked={method === option.value}
                    disabled={Boolean(option.disabled)}
                    onChange={() => setMethod(option.value)}
                  />
                  <span>
                    <span className="block font-medium">{option.label}</span>
                    <span className="block text-[13px] text-muted-foreground">{option.disabled ?? option.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" loading={save.isPending}>
              {method === 'credit' ? 'Registrar e lançar a troca' : 'Registrar devolução'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
