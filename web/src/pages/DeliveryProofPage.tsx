import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Camera, CheckCircle2, MapPin, MessageCircle, Undo2, X } from 'lucide-react';
import { useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { InvoiceLink } from '@/components/InvoiceLink';
import { ReasonDialog } from '@/components/ReasonDialog';
import { EmptyState } from '@/components/shared';
import { SignaturePad, type SignaturePadHandle } from '@/components/SignaturePad';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { Alert, Badge, Spinner } from '@/components/ui/misc';
import { api, ApiError } from '@/lib/api';
import { KIND_LABEL, mapsUrl, PERIOD_LABEL, STATUS_LABEL, STATUS_VARIANT } from '@/lib/deliveries';
import { formatDateTime, formatDay, formatOrderNumber, formatQuantity, formatWhatsapp } from '@/lib/format';
import { useDocumentTitle } from '@/lib/hooks';
import { compressPhoto } from '@/lib/photo';
import type { Delivery } from '@/lib/types';

function Proof({ delivery }: { delivery: Delivery }) {
  const proof = useQuery({
    queryKey: ['delivery-proof', delivery.id],
    queryFn: () => api<{ signature: string | null; photo: string | null }>(`/deliveries/${delivery.id}/proof`),
    enabled: delivery.has_signature || delivery.has_photo,
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-success">
          <CheckCircle2 className="size-5" aria-hidden />
          {delivery.kind === 'pickup' ? 'Retirado' : 'Entregue'}
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        <p>
          {delivery.completed_at && formatDateTime(delivery.completed_at)}
          {delivery.completed_by_name && ` · confirmado por ${delivery.completed_by_name}`}
        </p>
        {delivery.receiver_name && (
          <p>
            Recebido por <strong>{delivery.receiver_name}</strong>
            {delivery.receiver_document && ` (${delivery.receiver_document})`}
          </p>
        )}
        {proof.data?.signature && (
          <figure className="grid gap-1">
            <img src={proof.data.signature} alt="Assinatura de quem recebeu" className="max-h-40 rounded-md border border-border bg-card object-contain" />
            <figcaption className="text-[13px] text-muted-foreground">Assinatura</figcaption>
          </figure>
        )}
        {proof.data?.photo && (
          <figure className="grid gap-1">
            <img src={proof.data.photo} alt="Foto da entrega" className="max-h-96 rounded-md border border-border object-contain" />
            <figcaption className="text-[13px] text-muted-foreground">Foto da entrega</figcaption>
          </figure>
        )}
      </CardContent>
    </Card>
  );
}

/** Comprovante de entrega, pensado para o celular do motorista. */
export function DeliveryProofPage() {
  const id = Number(useParams().id);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const signature = useRef<SignaturePadHandle>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const [receiver, setReceiver] = useState('');
  const [document, setDocument] = useState('');
  const [notes, setNotes] = useState('');
  const [photo, setPhoto] = useState<string | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failOpen, setFailOpen] = useState(false);

  const query = useQuery({
    queryKey: ['delivery', id],
    queryFn: () => api<{ delivery: Delivery }>(`/deliveries/${id}`).then((r) => r.delivery),
    enabled: Number.isInteger(id) && id > 0,
  });
  const delivery = query.data;
  useDocumentTitle(delivery ? `Entrega do pedido ${formatOrderNumber(delivery.order_id)}` : 'Entrega');

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['deliveries'] });
    queryClient.invalidateQueries({ queryKey: ['delivery-routes'] });
    queryClient.invalidateQueries({ queryKey: ['order-deliveries'] });
  };

  const complete = useMutation({
    mutationFn: () =>
      api<{ delivery: Delivery }>(`/deliveries/${id}/complete`, {
        method: 'POST',
        body: {
          receiver_name: receiver,
          receiver_document: document || null,
          signature: signature.current?.toDataUrl() ?? null,
          photo,
          notes: notes || null,
        },
      }),
    onSuccess: ({ delivery: next }) => {
      queryClient.setQueryData(['delivery', id], next);
      invalidate();
      toast.success('Entrega confirmada.');
      window.scrollTo({ top: 0 });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Não foi possível confirmar. Tente de novo.'),
  });

  const fail = useMutation({
    mutationFn: (reason: string) => api(`/deliveries/${id}/cancel`, { method: 'POST', body: { reason } }),
    onSuccess: () => {
      invalidate();
      setFailOpen(false);
      toast.success('Registrado. A entrega volta para reagendar.');
      navigate('/entregas');
    },
  });

  async function pickPhoto(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setPhotoBusy(true);
    try {
      setPhoto(await compressPhoto(file));
    } catch (err) {
      setError((err as Error).message || 'Não foi possível ler a foto.');
    } finally {
      setPhotoBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (receiver.trim().length < 2) return setError('Informe o nome de quem recebeu.');
    setError(null);
    complete.mutate();
  }

  if (query.isPending) return <Spinner className="py-10" />;
  if (!delivery) {
    return (
      <EmptyState
        title="Entrega não encontrada"
        action={
          <Button asChild variant="outline">
            <Link to="/entregas">Voltar para entregas</Link>
          </Button>
        }
      />
    );
  }

  const open = delivery.status === 'scheduled' || delivery.status === 'in_route';
  const phone = delivery.client_whatsapp;

  return (
    <div className="mx-auto grid max-w-xl grid-cols-1 gap-4">
      <Link to="/entregas" className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" />
        Entregas
      </Link>

      <div className="grid gap-1">
        <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          {KIND_LABEL[delivery.kind]} do pedido
          <Link to={`/pedidos/${delivery.order_id}`} className="font-semibold text-foreground tabular-nums hover:underline">
            {formatOrderNumber(delivery.order_id)}
          </Link>
          <Badge variant={STATUS_VARIANT[delivery.status]}>{STATUS_LABEL[delivery.status]}</Badge>
          {delivery.invoice && <InvoiceLink invoice={delivery.invoice} />}
        </p>
        <h1 className="text-2xl font-bold tracking-tight">{delivery.client_name}</h1>
        {delivery.scheduled_date && (
          <p className="text-sm text-muted-foreground">
            {formatDay(delivery.scheduled_date)}
            {delivery.period && ` · ${PERIOD_LABEL[delivery.period]}`}
          </p>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        {delivery.address && (
          <Button asChild variant="outline">
            <a href={mapsUrl(delivery.address)} target="_blank" rel="noreferrer">
              <MapPin />
              Abrir no mapa
            </a>
          </Button>
        )}
        <Button asChild variant="outline">
          <a href={`https://wa.me/${phone}`} target="_blank" rel="noreferrer">
            <MessageCircle />
            {formatWhatsapp(phone)}
          </a>
        </Button>
      </div>

      {delivery.address && <p className="text-sm whitespace-pre-line">{delivery.address}</p>}

      <Card>
        <CardHeader>
          <CardTitle>O que vai</CardTitle>
        </CardHeader>
        <ul className="divide-y divide-border border-t border-border">
          {delivery.items.map((item) => (
            <li key={item.order_item_id} className="flex items-baseline gap-3 px-5 py-2.5 text-sm">
              <span className="w-24 shrink-0 text-right font-semibold tabular-nums">
                {formatQuantity(item.quantity)} {item.unit}
              </span>
              <span className="min-w-0 flex-1">{item.product_name}</span>
            </li>
          ))}
        </ul>
        {(delivery.notes || delivery.order_notes) && (
          <CardContent className="pt-3 text-sm text-muted-foreground">
            {delivery.notes && <p>Entrega: {delivery.notes}</p>}
            {delivery.order_notes && <p>Pedido: {delivery.order_notes}</p>}
          </CardContent>
        )}
      </Card>

      {delivery.status === 'done' && <Proof delivery={delivery} />}
      {delivery.status === 'cancelled' && (
        <Alert variant="danger" title="Esta entrega foi cancelada.">
          {delivery.cancel_reason && <p>Motivo: {delivery.cancel_reason}</p>}
        </Alert>
      )}

      {open && (
        <form onSubmit={submit} className="grid gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Comprovante</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              {error && <Alert variant="danger" title={error} />}
              <Field label="Quem recebeu" htmlFor="recebedor">
                <Input id="recebedor" value={receiver} onChange={(e) => setReceiver(e.target.value)} maxLength={120} autoComplete="off" />
              </Field>
              <Field label="Documento (opcional)" htmlFor="recebedor-doc">
                <Input id="recebedor-doc" value={document} onChange={(e) => setDocument(e.target.value)} maxLength={30} inputMode="numeric" />
              </Field>
              <div className="grid gap-1.5">
                <span className="text-sm font-medium">Assinatura</span>
                <SignaturePad ref={signature} />
              </div>
              <div className="grid gap-2">
                <span className="text-sm font-medium">Foto da entrega (opcional)</span>
                <input ref={photoInput} type="file" accept="image/*" capture="environment" className="hidden" onChange={pickPhoto} />
                {photo ? (
                  <div className="relative">
                    <img src={photo} alt="Foto da entrega" className="max-h-72 w-full rounded-md border border-border object-contain" />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="absolute top-2 right-2 size-8 bg-card"
                      onClick={() => setPhoto(null)}
                      aria-label="Tirar a foto"
                    >
                      <X />
                    </Button>
                  </div>
                ) : (
                  <Button type="button" variant="outline" loading={photoBusy} onClick={() => photoInput.current?.click()}>
                    <Camera />
                    Tirar foto
                  </Button>
                )}
              </div>
              <Field label="Observação (opcional)" htmlFor="entrega-observacao">
                <Input id="entrega-observacao" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={300} />
              </Field>
            </CardContent>
          </Card>
          <Button type="submit" size="lg" loading={complete.isPending}>
            <CheckCircle2 />
            Confirmar {delivery.kind === 'pickup' ? 'retirada' : 'entrega'}
          </Button>
          <Button type="button" variant="ghost" onClick={() => setFailOpen(true)}>
            <Undo2 />
            Não foi possível entregar
          </Button>
        </form>
      )}

      <ReasonDialog
        open={failOpen}
        onOpenChange={setFailOpen}
        title="Entrega não feita?"
        description="A entrega sai da agenda e a quantidade volta para o saldo do pedido, para reagendar."
        confirmLabel="Registrar"
        suggestions={['Cliente ausente', 'Endereço não encontrado', 'Cliente recusou', 'Sem acesso para o caminhão']}
        loading={fail.isPending}
        error={fail.error instanceof ApiError ? fail.error.message : null}
        onConfirm={(reason) => fail.mutate(reason)}
      />
    </div>
  );
}
