import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Ban, CheckCheck, CheckCircle2, Download, FileCheck2, Pencil, RotateCcw, Trash2, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { CancelOrderDialog } from '@/components/CancelOrderDialog';
import { OrderProgressCard } from '@/components/OrderProgressCard';
import { DiscountBreakdown, EmptyState, PriceTag, StatusBadge, WhatsAppIcon } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Alert, Spinner } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { api, ApiError } from '@/lib/api';
import { useUser } from '@/lib/auth';
import {
  documentLabel,
  formatDateTime,
  formatMoney,
  formatOrderNumber,
  formatPercent,
  formatQuantity,
  formatWhatsapp,
} from '@/lib/format';
import { useDocumentTitle } from '@/lib/hooks';
import type { Order } from '@/lib/types';

export function OrderDetailPage() {
  const id = Number(useParams().id);
  const user = useUser();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const justSaved = Boolean((location.state as { justSaved?: boolean } | null)?.justSaved);
  const [sendError, setSendError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'convert' | 'delete' | 'cancel' | null>(null);

  const query = useQuery({
    queryKey: ['order', id],
    queryFn: () => api<{ order: Order }>(`/orders/${id}`).then((r) => r.order),
    enabled: Number.isInteger(id) && id > 0,
  });
  const order = query.data;
  useDocumentTitle(order ? `${documentLabel(order.status, order.cancelled_from)} ${formatOrderNumber(order.id)}` : 'Pedido');

  const refresh = (next: Order) => {
    queryClient.setQueryData(['order', id], next);
    queryClient.invalidateQueries({ queryKey: ['orders'] });
    queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  };

  const send = useMutation({
    mutationFn: () => api<{ sent_at: string }>(`/orders/${id}/whatsapp`, { method: 'POST' }),
    onMutate: () => setSendError(null),
    onSuccess: ({ sent_at }) => {
      if (order) refresh({ ...order, sent_at });
      toast.success(`Enviado com sucesso para o WhatsApp de ${order?.client_name}.`);
    },
    onError: (err) => setSendError(err instanceof ApiError ? err.message : 'Erro desconhecido.'),
  });

  const convert = useMutation({
    mutationFn: () => api<{ order: Order }>(`/orders/${id}/convert`, { method: 'POST' }),
    onSuccess: ({ order: next }) => {
      refresh(next);
      setConfirm(null);
      toast.success(`Orçamento convertido no pedido nº ${formatOrderNumber(next.id)}.`);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Não foi possível converter.'),
  });

  const reopen = useMutation({
    mutationFn: () => api<{ order: Order }>(`/orders/${id}/reopen`, { method: 'POST' }),
    onSuccess: ({ order: next }) => {
      refresh(next);
      toast.success('Orçamento reaberto.');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Não foi possível reabrir.'),
  });

  const remove = useMutation({
    mutationFn: () => api<void>(`/orders/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: ['order', id] });
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      toast.success('Excluído.');
      navigate('/pedidos', { replace: true });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Não foi possível excluir.'),
  });

  if (query.isPending) return <Spinner className="py-10" />;
  if (!order) {
    return (
      <EmptyState
        title="Pedido não encontrado"
        description="Ele pode ter sido excluído ou pertencer a outra loja."
        action={
          <Button asChild variant="outline">
            <Link to="/pedidos">Voltar para pedidos</Link>
          </Button>
        }
      />
    );
  }

  const label = documentLabel(order.status, order.cancelled_from);
  const number = formatOrderNumber(order.id);
  const isQuote = order.status === 'quote';
  const isCancelled = order.status === 'cancelled';
  const canCancel = isQuote || (order.status === 'order' && user.role === 'admin');
  const pdfUrl = `/api/orders/${order.id}/pdf?download=1`;

  return (
    <div>
      <Link
        to="/pedidos"
        className="mb-3 inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Pedidos
      </Link>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="grid gap-1.5">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight">
              {label} nº {number}
            </h1>
            <StatusBadge status={order.status} cancelledFrom={order.cancelled_from} />
          </div>
          <p className="text-sm text-muted-foreground">
            Criado em {formatDateTime(order.created_at)} por {order.user_name}, {order.store_name}
            {order.confirmed_at && order.status === 'order' && <>. Confirmado em {formatDateTime(order.confirmed_at)}</>}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {isQuote && (
            <>
              <Button variant="outline" asChild>
                <Link to={`/pedidos/${order.id}/editar`}>
                  <Pencil />
                  Editar
                </Link>
              </Button>
              <Button variant="steel" onClick={() => setConfirm('convert')}>
                <FileCheck2 />
                Converter em pedido
              </Button>
            </>
          )}
          {canCancel && (
            <Button variant="outline" onClick={() => setConfirm('cancel')}>
              <Ban />
              {isQuote ? 'Marcar como perdido' : 'Cancelar pedido'}
            </Button>
          )}
          {isCancelled && order.cancelled_from === 'quote' && (
            <Button variant="outline" loading={reopen.isPending} onClick={() => reopen.mutate()}>
              <RotateCcw />
              Reabrir orçamento
            </Button>
          )}
          {user.role === 'admin' && (
            <Button variant="destructive-ghost" onClick={() => setConfirm('delete')}>
              <Trash2 />
              Excluir
            </Button>
          )}
        </div>
      </div>

      {isCancelled && (
        <Alert
          variant="danger"
          icon={<Ban />}
          title={`${label} em ${formatDateTime(order.cancelled_at!)} por ${order.cancelled_by_name}.`}
          className="mb-6"
        >
          <p>Motivo: {order.cancel_reason}</p>
        </Alert>
      )}

      {justSaved && !order.sent_at && !sendError && (
        <Alert variant="success" icon={<CheckCircle2 />} title={`${label} salvo.`} className="mb-6">
          <p>Agora envie o PDF para o cliente pelo WhatsApp.</p>
        </Alert>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
        <div className="grid min-w-0 grid-cols-1 gap-6">
          <Card>
            <div className="overflow-x-auto">
              <div className="min-w-[520px]">
                <CardHeader>
                  <CardTitle>Itens</CardTitle>
                  <span className="text-sm text-muted-foreground">
                    {order.items.length} {order.items.length === 1 ? 'item' : 'itens'}
                  </span>
                </CardHeader>
                <Table>
                  <THead>
                    <TR>
                      <TH className="pl-5">Código</TH>
                      <TH>Produto</TH>
                      <TH className="text-center">Un.</TH>
                      <TH className="text-right">Qtd.</TH>
                      <TH className="text-right">Preço unit.</TH>
                      <TH className="pr-5 text-right">Subtotal</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {order.items.map((item) => (
                      <TR key={item.id}>
                        <TD className="pl-5 text-muted-foreground tabular-nums">{item.product_code ?? '-'}</TD>
                        <TD className="font-medium">{item.product_name}</TD>
                        <TD className="text-center text-muted-foreground">{item.unit}</TD>
                        <TD className="text-right tabular-nums">{formatQuantity(item.quantity)}</TD>
                        <TD className="text-right tabular-nums">{formatMoney(item.unit_price)}</TD>
                        <TD className="pr-5 text-right font-semibold tabular-nums">{formatMoney(item.subtotal)}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
            </div>
          </Card>

          {order.delivery_address && (
            <Card>
              <CardHeader>
                <CardTitle>Endereço de entrega</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm leading-relaxed whitespace-pre-line">{order.delivery_address}</p>
              </CardContent>
            </Card>
          )}

          {order.notes && (
            <Card>
              <CardHeader>
                <CardTitle>Observações</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm leading-relaxed whitespace-pre-line">{order.notes}</p>
              </CardContent>
            </Card>
          )}
        </div>

        <aside className="grid gap-4">
          <DiscountBreakdown
            subtotalCents={Math.round(order.subtotal_amount * 100)}
            discountCents={Math.round(order.discount_amount * 100)}
            discountLabel={
              order.discount_type === 'percent' && order.discount_value
                ? `Desconto (${formatPercent(order.discount_value)})`
                : 'Desconto'
            }
          />
          <PriceTag cents={Math.round(order.total_amount * 100)} />

          {order.workflow && <OrderProgressCard order={order} workflow={order.workflow} />}

          <Card>
            <CardContent className="grid gap-4 pt-5">
              <div>
                <p className="text-sm text-muted-foreground">Cliente</p>
                <p className="font-semibold">{order.client_name}</p>
                <p className="text-sm tabular-nums">{formatWhatsapp(order.client_whatsapp)}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Forma de pagamento</p>
                <p className={order.payment_method_name ? 'font-semibold' : 'text-sm text-muted-foreground'}>
                  {order.payment_method_name ?? 'Não informada'}
                </p>
              </div>

              <Button
                variant="whatsapp"
                size="lg"
                className="w-full"
                loading={send.isPending}
                disabled={isCancelled}
                onClick={() => send.mutate()}
              >
                {!send.isPending && <WhatsAppIcon />}
                {send.isPending ? 'Gerando PDF e enviando...' : order.sent_at ? 'Enviar de novo' : 'Enviar para o cliente'}
              </Button>

              {order.sent_at && !sendError && (
                <p className="flex items-center gap-1.5 text-[13px] font-medium text-success">
                  <CheckCheck className="size-4" />
                  Enviado por WhatsApp em {formatDateTime(order.sent_at)}
                </p>
              )}

              {sendError && (
                <Alert
                  variant="danger"
                  icon={<TriangleAlert />}
                  title="Falha ao enviar WhatsApp. O PDF foi gerado e pode ser baixado manualmente."
                >
                  <p>{sendError}</p>
                  <Button asChild variant="outline" size="sm" className="mt-2 justify-self-start">
                    <a href={pdfUrl} download>
                      <Download />
                      Baixar PDF
                    </a>
                  </Button>
                </Alert>
              )}

              {!sendError && (
                <Button asChild variant="outline" className="w-full">
                  <a href={pdfUrl} download>
                    <Download />
                    Baixar PDF
                  </a>
                </Button>
              )}
            </CardContent>
          </Card>
        </aside>
      </div>

      <ConfirmDialog
        open={confirm === 'convert'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title="Converter em pedido?"
        description="O orçamento vira uma venda confirmada e não poderá mais ser editado."
        confirmLabel="Converter em pedido"
        loading={convert.isPending}
        onConfirm={() => convert.mutate()}
      />
      <CancelOrderDialog
        order={order}
        open={confirm === 'cancel'}
        onOpenChange={(open) => !open && setConfirm(null)}
        onCancelled={refresh}
      />
      <ConfirmDialog
        open={confirm === 'delete'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={`Excluir ${label.toLowerCase()} nº ${number}?`}
        description="Esta ação não pode ser desfeita."
        confirmLabel="Excluir"
        destructive
        loading={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </div>
  );
}
