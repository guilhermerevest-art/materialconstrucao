import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Ban, FileDown, FileInput, Pencil, Send, SquareCheck } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';
import { ReasonDialog } from '@/components/ReasonDialog';
import { PageHeader, WhatsAppIcon } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Checkbox, Field, Textarea } from '@/components/ui/input';
import { Alert, Badge, Skeleton } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { api, ApiError, toQuery } from '@/lib/api';
import { formatDocument } from '@/lib/fiscal';
import { formatDate, formatDateTime, formatDay, formatMoney, formatQuantity, formatWhatsapp } from '@/lib/format';
import { useDocumentTitle } from '@/lib/hooks';
import { PURCHASE_STATUS, purchaseNumber } from '@/lib/purchases';
import type { PurchaseOrderDetail } from '@/lib/types';
import { cn } from '@/lib/utils';

/** Quantidade na unidade do pedido: em sacos quando ele foi feito na unidade de compra. */
const inUnit = (quantity: number, factor: number | null) => formatQuantity(factor ? Math.round((quantity / factor) * 1000) / 1000 : quantity);

function WhatsappDialog({ order, onSent, onClose }: { order: PurchaseOrderDetail; onSent: () => void; onClose: () => void }) {
  const [message, setMessage] = useState(order.whatsapp_message);
  const [withPdf, setWithPdf] = useState(true);
  const [error, setError] = useState<{ text: string; fallback: boolean } | null>(null);
  const send = useMutation({
    mutationFn: () => api(`/purchase-orders/${order.id}/whatsapp`, { method: 'POST', body: { message, with_pdf: withPdf } }),
    onSuccess: () => {
      toast.success(`Pedido enviado para ${order.supplier.name}.`);
      onSent();
      onClose();
    },
    onError: (err) =>
      setError({
        text: err instanceof ApiError ? err.message : 'Não foi possível enviar.',
        fallback: err instanceof ApiError && err.code === 'WHATSAPP_NOT_CONFIGURED',
      }),
  });
  const markSent = useMutation({
    mutationFn: () => api(`/purchase-orders/${order.id}/sent`, { method: 'POST' }),
    onSuccess: () => {
      onSent();
      onClose();
    },
  });
  const phone = order.supplier.whatsapp;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Mandar ao fornecedor</DialogTitle>
          <DialogDescription>
            {order.supplier.name}
            {phone ? ` · ${formatWhatsapp(phone)}` : ''}
          </DialogDescription>
        </DialogHeader>
        {!phone ? (
          <Alert variant="danger" title="O fornecedor não tem WhatsApp cadastrado.">
            <p>Cadastre em Compras → Fornecedores, ou baixe o PDF e mande por e-mail.</p>
          </Alert>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              send.mutate();
            }}
            className="grid gap-4"
          >
            {error && (
              <Alert variant="danger" title={error.text}>
                {error.fallback && (
                  <Button asChild variant="outline" size="sm" className="mt-1 justify-self-start">
                    {/* Abre o WhatsApp do aparelho com a mensagem pronta; o PDF vai à parte. */}
                    <a href={`https://wa.me/${phone}?text=${encodeURIComponent(message)}`} target="_blank" rel="noreferrer" onClick={() => markSent.mutate()}>
                      Abrir no WhatsApp deste aparelho
                    </a>
                  </Button>
                )}
              </Alert>
            )}
            <Field label="Mensagem" htmlFor="compra-mensagem">
              <Textarea id="compra-mensagem" rows={9} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={2000} />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={withPdf} onChange={(e) => setWithPdf(e.target.checked)} />
              Mandar o pedido em PDF junto
            </label>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancelar
              </Button>
              <Button type="submit" variant="whatsapp" loading={send.isPending}>
                {!send.isPending && <WhatsAppIcon />}
                Enviar
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function PurchaseOrderPage() {
  const id = Number(useParams().id);
  useDocumentTitle(`Pedido de compra ${purchaseNumber(id)}`);
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<'whatsapp' | 'cancel' | 'close' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ['purchase-orders', 'detail', id],
    queryFn: () => api<{ purchase_order: PurchaseOrderDetail }>(`/purchase-orders/${id}`).then((r) => r.purchase_order),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['purchase-orders'] });

  const action = useMutation({
    mutationFn: ({ path, reason }: { path: 'sent' | 'cancel' | 'close'; reason?: string }) =>
      api(`/purchase-orders/${id}/${path}`, { method: 'POST', body: reason ? { reason } : undefined }),
    onSuccess: (_, { path }) => {
      refresh();
      setDialog(null);
      setActionError(null);
      toast.success(path === 'sent' ? 'Marcado como enviado.' : path === 'cancel' ? 'Pedido de compra cancelado.' : 'Pedido encerrado com o que chegou.');
    },
    onError: (err) => setActionError(err instanceof ApiError ? err.message : 'Não foi possível concluir.'),
  });

  if (query.isPending) return <Skeleton className="h-64" />;
  if (!query.data) return <Alert variant="danger" title="Pedido de compra não encontrado." />;
  const po = query.data;
  const status = PURCHASE_STATUS[po.status];
  const open = ['draft', 'sent', 'partial'].includes(po.status);
  const editable = po.status === 'draft' || po.status === 'sent';

  return (
    <div>
      <Link to="/compras" className="mb-3 inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" />
        Compras
      </Link>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            {purchaseNumber(po.id)}
            <Badge variant={status.variant}>{po.closed_short ? 'Encerrado com falta' : status.label}</Badge>
          </span>
        }
        description={`${po.supplier.name} · ${po.store_name} · criado em ${formatDate(po.created_at)} por ${po.user_name}`}
        actions={
          <>
            <Button asChild variant="outline">
              <a href={`/api/purchase-orders/${po.id}/pdf`} target="_blank" rel="noreferrer">
                <FileDown />
                PDF
              </a>
            </Button>
            {po.status !== 'cancelled' && po.status !== 'received' && (
              <Button variant="whatsapp" onClick={() => setDialog('whatsapp')}>
                <WhatsAppIcon />
                Mandar ao fornecedor
              </Button>
            )}
            {open && (
              <Button asChild>
                <Link to={`/estoque/entrada${toQuery({ pedido: po.id, loja: po.store_id })}`}>
                  <FileInput />
                  Receber (entrada de nota)
                </Link>
              </Button>
            )}
          </>
        }
      />

      {actionError && <Alert variant="danger" title={actionError} className="mb-4" />}
      {po.status === 'cancelled' && (
        <Alert variant="danger" title={`Cancelado em ${formatDateTime(po.cancelled_at!)}`} className="mb-4">
          <p>{po.cancel_reason}</p>
        </Alert>
      )}
      {po.closed_short && (
        <Alert title="Encerrado sem receber tudo" className="mb-4">
          <p>{po.cancel_reason}</p>
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="grid content-start gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Produtos</CardTitle>
              {po.total_amount > 0 && <span className="text-sm text-muted-foreground">Total estimado {formatMoney(po.total_amount)}</span>}
            </CardHeader>
            <Table>
              <THead>
                <TR>
                  <TH className="pl-4">Produto</TH>
                  <TH className="text-right">Pedido</TH>
                  <TH className="text-right">Chegou</TH>
                  <TH className="text-right">Custo</TH>
                  <TH className="pr-4 text-right">Total</TH>
                </TR>
              </THead>
              <TBody>
                {po.items.map((item) => {
                  const missing = Math.max(0, item.quantity - item.received_quantity);
                  const factor = item.purchase_unit ? item.purchase_factor : null;
                  return (
                    <TR key={item.id}>
                      <TD className="pl-4 font-medium">
                        {item.product_name}
                        {item.code && <span className="block text-xs font-normal text-muted-foreground tabular-nums">{item.code}</span>}
                      </TD>
                      <TD className="text-right whitespace-nowrap tabular-nums">
                        {factor ? (
                          <>
                            {formatQuantity(Math.round((item.quantity / factor) * 1000) / 1000)}{' '}
                            <span className="text-xs text-muted-foreground">{item.purchase_unit}</span>
                            <span className="block text-xs text-muted-foreground">
                              {formatQuantity(item.quantity)} {item.unit}
                            </span>
                          </>
                        ) : (
                          <>
                            {formatQuantity(item.quantity)} <span className="text-xs text-muted-foreground">{item.unit}</span>
                          </>
                        )}
                      </TD>
                      <TD className={cn('text-right whitespace-nowrap tabular-nums', missing === 0 ? 'text-success' : item.received_quantity > 0 && 'text-warning')}>
                        {item.received_quantity ? (
                          <>
                            {inUnit(item.received_quantity, factor)} <span className="text-xs">{factor ? item.purchase_unit : item.unit}</span>
                          </>
                        ) : (
                          '—'
                        )}
                        {missing > 0 && item.received_quantity > 0 && (
                          <span className="block text-xs">
                            falta {inUnit(missing, factor)} {factor ? item.purchase_unit : item.unit}
                          </span>
                        )}
                      </TD>
                      <TD className="text-right text-muted-foreground tabular-nums">
                        {item.unit_cost === null ? '—' : factor ? `${formatMoney(item.unit_cost * factor)}/${item.purchase_unit}` : formatMoney(item.unit_cost)}
                      </TD>
                      <TD className="pr-4 text-right tabular-nums">
                        {item.unit_cost !== null ? formatMoney(Math.round(item.quantity * item.unit_cost * 100) / 100) : '—'}
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </Card>

          {po.entries.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Notas recebidas</CardTitle>
              </CardHeader>
              <ul className="divide-y divide-border border-t border-border text-sm">
                {po.entries.map((e) => (
                  <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-2.5">
                    <span>
                      Entrada nº {e.id}
                      {e.invoice_number && ` · NF ${e.invoice_number}${e.invoice_series ? `/${e.invoice_series}` : ''}`}
                      <span className="block text-[13px] text-muted-foreground">
                        {formatDateTime(e.created_at)} · {e.user_name}
                      </span>
                    </span>
                    <span className="font-semibold tabular-nums">{formatMoney(e.total_amount)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {po.payables.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Contas a pagar</CardTitle>
                <Link to="/contas-a-pagar" className="text-sm font-medium text-primary hover:underline">
                  Ver todas
                </Link>
              </CardHeader>
              <ul className="divide-y divide-border border-t border-border text-sm">
                {po.payables.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-2.5">
                    <span className="tabular-nums">
                      {p.installment}/{p.installments} · vence {formatDay(p.due_date)}
                    </span>
                    <span className="flex items-center gap-2">
                      {p.status === 'paid' && <Badge variant="success">Paga</Badge>}
                      <span className="font-semibold tabular-nums">{formatMoney(p.amount)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>

        <div className="grid content-start gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Fornecedor</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-1 text-sm">
              <p className="font-medium">{po.supplier.name}</p>
              {po.supplier.document && <p className="text-muted-foreground tabular-nums">{formatDocument(po.supplier.document)}</p>}
              {po.supplier.contact_name && <p>Contato: {po.supplier.contact_name}</p>}
              {po.supplier.whatsapp && <p className="tabular-nums">{formatWhatsapp(po.supplier.whatsapp)}</p>}
              {po.supplier.email && <p className="break-all">{po.supplier.email}</p>}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Entrega</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-1 text-sm">
              <p>{po.expected_date ? `Receber até ${formatDay(po.expected_date)}` : 'Sem data combinada'}</p>
              {po.sent_at && <p className="text-muted-foreground">Enviado em {formatDateTime(po.sent_at)}</p>}
              {po.received_at && <p className="text-muted-foreground">Recebido em {formatDateTime(po.received_at)}</p>}
              {po.notes && <p className="mt-2 whitespace-pre-line text-muted-foreground">{po.notes}</p>}
            </CardContent>
          </Card>
          {(editable || po.status === 'partial') && (
            <Card>
              <CardContent className="grid gap-2 pt-5">
                {po.status === 'draft' && (
                  <Button variant="outline" onClick={() => action.mutate({ path: 'sent' })} loading={action.isPending && action.variables?.path === 'sent'}>
                    <Send />
                    Marcar como enviado
                  </Button>
                )}
                {editable && (
                  <Button asChild variant="outline">
                    <Link to={`/compras/${po.id}/editar`}>
                      <Pencil />
                      Editar pedido
                    </Link>
                  </Button>
                )}
                {editable && (
                  <Button variant="ghost" className="text-destructive" onClick={() => setDialog('cancel')}>
                    <Ban />
                    Cancelar pedido
                  </Button>
                )}
                {po.status === 'partial' && (
                  <Button variant="outline" onClick={() => setDialog('close')}>
                    <SquareCheck />
                    Encerrar sem o resto
                  </Button>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {dialog === 'whatsapp' && <WhatsappDialog order={po} onSent={refresh} onClose={() => setDialog(null)} />}
      <ReasonDialog
        open={dialog === 'cancel' || dialog === 'close'}
        onOpenChange={(o) => !o && setDialog(null)}
        title={dialog === 'close' ? 'Encerrar o pedido' : 'Cancelar o pedido de compra'}
        description={
          dialog === 'close'
            ? 'O que chegou fica no estoque; o resto deixa de ser esperado (e volta a aparecer em "O que comprar").'
            : 'O pedido deixa de ser esperado. Avise o fornecedor.'
        }
        confirmLabel={dialog === 'close' ? 'Encerrar' : 'Cancelar pedido'}
        destructive={dialog === 'cancel'}
        suggestions={dialog === 'close' ? ['Fornecedor sem estoque do resto', 'Compramos de outro fornecedor'] : ['Fornecedor sem estoque', 'Preço mudou', 'Pedido em dobro']}
        loading={action.isPending}
        error={actionError}
        onConfirm={(reason) => action.mutate({ path: dialog === 'close' ? 'close' : 'cancel', reason })}
      />
    </div>
  );
}
