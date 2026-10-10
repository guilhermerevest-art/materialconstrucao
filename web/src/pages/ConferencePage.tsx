import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, CircleAlert, FileText, Minus, Plus, ScanBarcode } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { EmptyState, PageHeader } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { Alert, Badge, Spinner } from '@/components/ui/misc';
import { api, ApiError, toQuery } from '@/lib/api';
import { decimalToInput, formatDateTime, formatDay, formatOrderNumber, formatQuantity, parseDecimal } from '@/lib/format';
import { useDocumentTitle } from '@/lib/hooks';
import { cn } from '@/lib/utils';

type SeparationItem = {
  order_item_id: number;
  product_id: number;
  product_code: string | null;
  product_name: string;
  unit: string;
  quantity: number;
};

type Check = {
  id: number;
  delivery_id: number | null;
  ok: boolean;
  items: { order_item_id: number; product_name: string; unit: string; expected: number; counted: number }[];
  note: string | null;
  created_at: string;
  user_name: string;
};

type Separation = {
  order: { id: number; client_name: string; delivery_address: string | null; notes: string | null };
  delivery: { id: number; kind: 'pickup' | 'delivery'; scheduled_date: string | null; period: string | null; address: string | null } | null;
  items: SeparationItem[];
  checks: Check[];
};

/** Bipe de leitura: agudo quando achou, grave quando o código não é do pedido. */
function beep(ok: boolean) {
  try {
    const audio = new AudioContext();
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.frequency.value = ok ? 1046 : 220;
    oscillator.type = ok ? 'sine' : 'square';
    gain.gain.setValueAtTime(0.15, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + (ok ? 0.12 : 0.4));
    oscillator.connect(gain).connect(audio.destination);
    oscillator.start();
    oscillator.stop(audio.currentTime + (ok ? 0.12 : 0.4));
    oscillator.onended = () => audio.close();
  } catch {
    // Sem áudio: a mensagem na tela basta.
  }
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;

/**
 * Conferência da separação: o separador bipa o código de cada volume (ou digita
 * "5*CIM-50" para cinco de uma vez) e ajusta à mão o que não tem etiqueta.
 */
export function ConferencePage() {
  const orderId = Number(useParams().id);
  const [params] = useSearchParams();
  const deliveryId = Number(params.get('entrega')) || null;
  const queryClient = useQueryClient();
  const scanRef = useRef<HTMLInputElement>(null);
  const [counted, setCounted] = useState<Record<number, number>>({});
  const [scan, setScan] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [note, setNote] = useState('');
  useDocumentTitle(`Conferência ${formatOrderNumber(orderId)}`);

  const query = useQuery({
    queryKey: ['separation', orderId, deliveryId],
    queryFn: () => api<Separation>(`/orders/${orderId}/separation${toQuery({ delivery_id: deliveryId })}`),
  });
  const data = query.data;

  useEffect(() => {
    scanRef.current?.focus();
  }, [data?.order.id]);

  const save = useMutation({
    mutationFn: () =>
      api<{ check: Check }>(`/orders/${orderId}/checks`, {
        method: 'POST',
        body: {
          delivery_id: deliveryId,
          note: note || null,
          items: (data?.items ?? []).map((i) => ({ order_item_id: i.order_item_id, counted: counted[i.order_item_id] ?? 0 })),
        },
      }),
    onSuccess: ({ check }) => {
      queryClient.invalidateQueries({ queryKey: ['separation', orderId] });
      toast.success(check.ok ? 'Conferência registrada: tudo certo.' : 'Conferência registrada com divergência.');
      setCounted({});
      setNote('');
      setMessage(null);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Não foi possível registrar.'),
  });

  function add(item: SeparationItem, amount: number) {
    setCounted((c) => ({ ...c, [item.order_item_id]: Math.max(0, round3((c[item.order_item_id] ?? 0) + amount)) }));
  }

  function submitScan(event: FormEvent) {
    event.preventDefault();
    const text = scan.trim();
    setScan('');
    if (!text || !data) return;
    // "5*CIM-50" ou "5xCIM-50": cinco volumes de uma vez.
    const match = text.match(/^(\d+(?:[.,]\d+)?)\s*[*xX]\s*(.+)$/);
    const amount = match ? (parseDecimal(match[1]!) ?? 1) : 1;
    const code = (match ? match[2]! : text).trim().toLowerCase();
    const candidates = data.items.filter((i) => i.product_code?.toLowerCase() === code);
    // Mesmo produto em duas linhas: completa a primeira que ainda falta.
    const item = candidates.find((i) => (counted[i.order_item_id] ?? 0) < i.quantity) ?? candidates[0];
    if (!item) {
      beep(false);
      setMessage({ ok: false, text: `O código "${text}" não é deste ${data.delivery ? 'carregamento' : 'pedido'}. Deixe o produto de lado.` });
      return;
    }
    const next = round3((counted[item.order_item_id] ?? 0) + amount);
    add(item, amount);
    const over = next > item.quantity;
    beep(!over);
    setMessage({
      ok: !over,
      text: over
        ? `${item.product_name}: ${formatQuantity(next)} de ${formatQuantity(item.quantity)} ${item.unit}. Passou do pedido!`
        : `${item.product_name}: ${formatQuantity(next)} de ${formatQuantity(item.quantity)} ${item.unit}`,
    });
  }

  if (query.isPending) return <Spinner className="py-10" />;
  if (query.isError || !data) {
    return (
      <EmptyState
        title="Separação indisponível"
        description={query.error instanceof ApiError ? query.error.message : undefined}
        action={
          <Button asChild variant="outline">
            <Link to={`/pedidos/${orderId}`}>Voltar ao pedido</Link>
          </Button>
        }
      />
    );
  }

  const status = (item: SeparationItem) => {
    const value = counted[item.order_item_id] ?? 0;
    if (Math.abs(value - item.quantity) < 0.0005) return 'ok';
    return value > item.quantity ? 'over' : 'short';
  };
  const done = data.items.filter((i) => status(i) === 'ok').length;
  const allOk = done === data.items.length && data.items.length > 0;
  const pdfUrl = `/api/orders/${orderId}/separation/pdf${toQuery({ delivery_id: deliveryId })}`;

  return (
    <div className="mx-auto grid max-w-3xl grid-cols-1 gap-5">
      <Link to={`/pedidos/${orderId}`} className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" />
        Pedido {formatOrderNumber(orderId)}
      </Link>
      <PageHeader
        className="mb-0"
        title="Separação e conferência"
        description={
          <>
            {data.order.client_name}
            {data.delivery
              ? ` · ${data.delivery.kind === 'pickup' ? 'retirada' : 'entrega'}${data.delivery.scheduled_date ? ` de ${formatDay(data.delivery.scheduled_date)}` : ''}`
              : ' · tudo o que falta sair do pedido'}
          </>
        }
        actions={
          <Button asChild variant="outline">
            <a href={pdfUrl} target="_blank" rel="noreferrer">
              <FileText />
              Imprimir lista
            </a>
          </Button>
        }
      />

      {!data.items.length ? (
        <Alert variant="success" icon={<CheckCircle2 />} title="Nada para separar: tudo já foi entregue." />
      ) : (
        <>
          <Card>
            <CardContent className="grid gap-3 pt-5">
              <form onSubmit={submitScan} className="flex gap-2">
                <div className="relative flex-1">
                  <ScanBarcode className="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    ref={scanRef}
                    aria-label="Código do produto"
                    placeholder="Bipe o código (ou 5*CIM-50 para cinco)"
                    value={scan}
                    onChange={(e) => setScan(e.target.value)}
                    className="h-12 pl-10 text-base"
                    autoComplete="off"
                  />
                </div>
                <Button type="submit" size="lg" variant="steel">
                  Conferir
                </Button>
              </form>
              {message && (
                <p
                  role="status"
                  className={cn(
                    'flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium',
                    message.ok ? 'bg-success-soft text-success' : 'bg-destructive-soft text-destructive',
                  )}
                >
                  {message.ok ? <CheckCircle2 className="size-4" /> : <CircleAlert className="size-4" />}
                  {message.text}
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Itens</CardTitle>
              <Badge variant={allOk ? 'success' : 'neutral'}>
                {done} de {data.items.length} conferidos
              </Badge>
            </CardHeader>
            <ul className="divide-y divide-border border-t border-border">
              {data.items.map((item) => {
                const state = status(item);
                const value = counted[item.order_item_id] ?? 0;
                return (
                  <li
                    key={item.order_item_id}
                    className={cn('flex flex-wrap items-center gap-3 px-5 py-3', state === 'ok' && 'bg-success-soft/60', state === 'over' && 'bg-destructive-soft/60')}
                  >
                    <div className="min-w-0 flex-[1_1_12rem]">
                      <p className="font-medium">{item.product_name}</p>
                      <p className="text-[13px] text-muted-foreground tabular-nums">
                        {item.product_code ?? 'sem código'} · separar {formatQuantity(item.quantity)} {item.unit}
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button variant="outline" size="icon" className="size-9" onClick={() => add(item, -1)} aria-label={`Tirar um de ${item.product_name}`}>
                        <Minus />
                      </Button>
                      <Input
                        aria-label={`Contado de ${item.product_name}`}
                        inputMode="decimal"
                        className="w-20 text-center font-semibold"
                        value={value ? decimalToInput(value) : ''}
                        placeholder="0"
                        onChange={(e) => {
                          const parsed = e.target.value.trim() ? parseDecimal(e.target.value) : 0;
                          if (parsed !== null) setCounted((c) => ({ ...c, [item.order_item_id]: parsed }));
                        }}
                      />
                      <Button variant="outline" size="icon" className="size-9" onClick={() => add(item, 1)} aria-label={`Somar um de ${item.product_name}`}>
                        <Plus />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setCounted((c) => ({ ...c, [item.order_item_id]: item.quantity }))}
                        title="Conferido sem bipar (granel, sem etiqueta)"
                      >
                        Tudo
                      </Button>
                    </div>
                    <span className="w-20 text-right text-sm font-semibold">
                      {state === 'ok' ? (
                        <span className="text-success">Ok</span>
                      ) : state === 'over' ? (
                        <span className="text-destructive">Sobra {formatQuantity(round3(value - item.quantity))}</span>
                      ) : (
                        <span className="text-muted-foreground">Falta {formatQuantity(round3(item.quantity - value))}</span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
            <CardContent className="grid gap-3 pt-4">
              <Field label="Observação (opcional)" htmlFor="conferencia-obs" hint={allOk ? undefined : 'Explique a divergência: ela fica registrada no pedido.'}>
                <Input id="conferencia-obs" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
              </Field>
              <Button size="lg" variant={allOk ? 'default' : 'outline'} loading={save.isPending} onClick={() => save.mutate()}>
                <CheckCircle2 />
                {allOk ? 'Registrar conferência' : 'Registrar com divergência'}
              </Button>
            </CardContent>
          </Card>
        </>
      )}

      {data.checks.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Conferências registradas</CardTitle>
          </CardHeader>
          <ul className="divide-y divide-border border-t border-border text-sm">
            {data.checks.map((check) => (
              <li key={check.id} className="grid gap-0.5 px-5 py-3">
                <p className="flex flex-wrap items-center gap-2">
                  <Badge variant={check.ok ? 'success' : 'danger'}>{check.ok ? 'Tudo certo' : 'Com divergência'}</Badge>
                  <span className="text-muted-foreground">
                    {check.user_name} · {formatDateTime(check.created_at)}
                  </span>
                </p>
                {!check.ok && (
                  <p className="text-[13px] text-muted-foreground">
                    {check.items
                      .filter((i) => Math.abs(i.expected - i.counted) >= 0.0005)
                      .map((i) => `${i.product_name}: ${formatQuantity(i.counted)} de ${formatQuantity(i.expected)} ${i.unit}`)
                      .join(' · ')}
                  </p>
                )}
                {check.note && <p className="text-[13px] italic">{check.note}</p>}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
