import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, ScanBarcode } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';
import { ReasonDialog } from '@/components/ReasonDialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Checkbox, Input } from '@/components/ui/input';
import { Alert, Badge, Skeleton } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { api, ApiError } from '@/lib/api';
import { useUser } from '@/lib/auth';
import { decimalToInput, formatDateTime, formatMoney, formatQuantity, parseDecimal } from '@/lib/format';
import { useDocumentTitle } from '@/lib/hooks';
import { COUNT_STATUS } from '@/lib/routines';
import type { StockCountDetail, StockCountItem } from '@/lib/types';
import { cn } from '@/lib/utils';

const difference = (i: StockCountItem) =>
  i.counted_quantity === null || i.expected_quantity === null ? null : Math.round((i.counted_quantity - i.expected_quantity) * 1000) / 1000;

/** Contando: o código (ou o leitor) leva ao produto; a quantidade salva ao sair do campo ou no Enter. */
function Counting({ data, onChanged }: { data: StockCountDetail; onChanged: () => void }) {
  const [values, setValues] = useState<Record<number, string>>({});
  const [scan, setScan] = useState('');
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const inputs = useRef<Record<number, HTMLInputElement | null>>({});
  const items = data.items;
  const counted = items.filter((i) => i.counted_quantity !== null).length;
  const value = (i: StockCountItem) => values[i.id] ?? (i.counted_quantity !== null ? decimalToInput(i.counted_quantity) : '');

  async function save(item: StockCountItem) {
    const text = value(item).trim();
    const quantity = text ? parseDecimal(text) : null;
    if (text && (quantity === null || quantity < 0)) return toast.error(`Quantidade inválida para ${item.product_name}.`);
    if (quantity === item.counted_quantity) return;
    try {
      await api(`/stock-counts/${data.count.id}/items/${item.id}`, { method: 'PUT', body: { counted_quantity: quantity } });
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Não foi possível salvar.');
    }
  }

  function focusNext(index: number) {
    const next = items.slice(index + 1).find((i) => i.counted_quantity === null) ?? items[index + 1];
    if (next) inputs.current[next.id]?.focus();
  }

  function onScan(event: FormEvent) {
    event.preventDefault();
    const code = scan.trim().toLowerCase();
    if (!code) return;
    const item = items.find((i) => i.product_code?.toLowerCase() === code || i.gtin === code);
    setScan('');
    if (!item) return toast.error('Este código não está nesta contagem.');
    inputs.current[item.id]?.focus();
    inputs.current[item.id]?.select();
  }

  const submit = useMutation({
    mutationFn: () => api(`/stock-counts/${data.count.id}/submit`, { method: 'POST' }),
    onSuccess: () => {
      toast.success('Contagem enviada para conferência.');
      onChanged();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Não foi possível enviar.'),
  });
  const cancel = useMutation({
    mutationFn: () => api(`/stock-counts/${data.count.id}/cancel`, { method: 'POST' }),
    onSuccess: () => {
      toast.success('Contagem cancelada.');
      onChanged();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Não foi possível cancelar.'),
  });

  return (
    <>
      <Alert title="Contagem cega" className="mb-4">
        <p>Conte o que está na prateleira e no depósito, sem olhar o sistema. Produto que não achou: deixe em branco.</p>
      </Alert>
      <form onSubmit={onScan} className="mb-4 flex gap-2">
        <div className="relative flex-1">
          <ScanBarcode className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Código ou código de barras"
            placeholder="Código ou leitor de código de barras"
            value={scan}
            onChange={(e) => setScan(e.target.value)}
            className="pl-9"
            autoFocus
          />
        </div>
        <Button type="submit" variant="outline">
          Ir
        </Button>
      </form>
      <Card>
        <ul className="divide-y divide-border">
          {items.map((item, index) => (
            <li key={item.id} className="flex items-center gap-3 px-4 py-3 sm:px-5">
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2 font-medium">
                  {item.product_name}
                  {item.abc_class && <Badge variant={item.abc_class === 'A' ? 'success' : item.abc_class === 'B' ? 'quote' : 'neutral'}>{item.abc_class}</Badge>}
                </span>
                <span className="block text-[13px] text-muted-foreground tabular-nums">
                  {item.product_code ?? 'sem código'} · {item.unit}
                  {item.counted_at && item.counted_by_name && ` · ${item.counted_by_name}`}
                </span>
              </span>
              <Input
                ref={(el) => {
                  inputs.current[item.id] = el;
                }}
                aria-label={`Quantidade contada de ${item.product_name}`}
                inputMode="decimal"
                value={value(item)}
                placeholder="—"
                onChange={(e) => setValues((v) => ({ ...v, [item.id]: e.target.value }))}
                onBlur={() => void save(item)}
                onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void save(item);
                    focusNext(index);
                  }
                }}
                className="h-11 w-24 text-right text-base tabular-nums"
              />
              <span className={cn('grid size-6 place-items-center', item.counted_quantity !== null ? 'text-success' : 'text-transparent')}>
                <Check className="size-5" />
              </span>
            </li>
          ))}
        </ul>
      </Card>
      <div className="sticky bottom-0 mt-4 flex flex-wrap items-center gap-3 border-t border-border bg-background/95 py-3 backdrop-blur">
        <span className="text-sm text-muted-foreground tabular-nums">
          {counted} de {items.length} contados
        </span>
        <Button variant="ghost" className="text-destructive" onClick={() => setCancelOpen(true)}>
          Cancelar contagem
        </Button>
        <Button size="lg" className="ml-auto" disabled={!counted} onClick={() => setConfirmSubmit(true)}>
          Enviar para conferência
        </Button>
      </div>
      <ConfirmDialog
        open={confirmSubmit}
        onOpenChange={setConfirmSubmit}
        title="Enviar a contagem?"
        description={
          counted < items.length
            ? `${items.length - counted} ${items.length - counted === 1 ? 'produto ficou' : 'produtos ficaram'} sem contar e não entram. Depois de enviada, a contagem não muda.`
            : 'Depois de enviada, a contagem não muda. O administrador confere e decide o que ajustar.'
        }
        confirmLabel="Enviar"
        loading={submit.isPending}
        onConfirm={() => submit.mutate(undefined, { onSettled: () => setConfirmSubmit(false) })}
      />
      <ConfirmDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title="Cancelar a contagem?"
        description="O que foi contado é descartado. Os produtos voltam a ser escolhidos na próxima contagem."
        confirmLabel="Cancelar contagem"
        cancelLabel="Voltar"
        destructive
        loading={cancel.isPending}
        onConfirm={() => cancel.mutate(undefined, { onSettled: () => setCancelOpen(false) })}
      />
    </>
  );
}

/** Conferência do administrador: esperado × contado, o valor da diferença e o que vira ajuste. */
function Review({ data, onChanged }: { data: StockCountDetail; onChanged: () => void }) {
  const counted = data.items.filter((i) => i.counted_quantity !== null);
  const withDiff = counted.filter((i) => Math.abs(difference(i) ?? 0) >= 0.0005);
  const [adjust, setAdjust] = useState<Set<number>>(() => new Set(withDiff.map((i) => i.id)));
  const [noteOpen, setNoteOpen] = useState(false);
  const pending = data.count.status === 'submitted';
  const total = withDiff.filter((i) => adjust.has(i.id)).reduce((sum, i) => sum + (difference(i) ?? 0) * (i.unit_cost ?? 0), 0);
  const review = useMutation({
    mutationFn: (note: string) => api<{ adjusted: number; value: number }>(`/stock-counts/${data.count.id}/review`, { method: 'POST', body: { adjust_item_ids: [...adjust], note } }),
    onSuccess: (result) => {
      toast.success(result.adjusted ? `${result.adjusted} ${result.adjusted === 1 ? 'ajuste lançado' : 'ajustes lançados'} (${formatMoney(result.value)}).` : 'Contagem conferida, sem ajustes.');
      setNoteOpen(false);
      onChanged();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Não foi possível conferir.'),
  });
  return (
    <>
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          ['Contados', `${counted.length} de ${data.items.length}`],
          ['Sem diferença', `${counted.length - withDiff.length}`],
          ['Com diferença', `${withDiff.length}`],
          [pending ? 'Ajuste marcado (a custo)' : 'Situação', pending ? formatMoney(Math.round(total * 100) / 100) : 'Conferida'],
        ].map(([label, value]) => (
          <div key={label} className="rounded-lg border border-border bg-card px-4 py-3">
            <p className="text-sm text-muted-foreground">{label}</p>
            <p className={cn('text-xl font-bold tabular-nums', label.startsWith('Ajuste') && total < 0 && 'text-destructive')}>{value}</p>
          </div>
        ))}
      </div>
      <Card>
        <CardHeader>
          <CardTitle>{pending ? 'Conferir' : 'Resultado'}</CardTitle>
          {pending && <span className="text-sm text-muted-foreground">Esperado = saldo + vendido ainda não entregue, na hora da contagem.</span>}
        </CardHeader>
        <Table>
          <THead>
            <TR>
              {pending && <TH className="w-10 pl-4"><span className="sr-only">Ajustar</span></TH>}
              <TH className={cn(!pending && 'pl-4')}>Produto</TH>
              <TH className="text-right">Esperado</TH>
              <TH className="text-right">Contado</TH>
              <TH className="text-right">Diferença</TH>
              <TH className="pr-4 text-right">Valor</TH>
            </TR>
          </THead>
          <TBody>
            {data.items.map((item) => {
              const diff = difference(item);
              const has = diff !== null && Math.abs(diff) >= 0.0005;
              return (
                <TR key={item.id} className={cn(item.counted_quantity === null && 'opacity-55')}>
                  {pending && (
                    <TD className="pl-4">
                      {has && (
                        <Checkbox
                          aria-label={`Ajustar ${item.product_name}`}
                          checked={adjust.has(item.id)}
                          onChange={(e) =>
                            setAdjust((set) => {
                              const next = new Set(set);
                              if (e.target.checked) next.add(item.id);
                              else next.delete(item.id);
                              return next;
                            })
                          }
                        />
                      )}
                    </TD>
                  )}
                  <TD className={cn('font-medium', !pending && 'pl-4')}>
                    {item.product_name}
                    <span className="block text-xs font-normal text-muted-foreground">
                      {item.product_code ?? ''}
                      {item.outcome === 'adjusted' && ' · ajustado'}
                      {item.outcome === 'ignored' && has && ' · mantido'}
                      {item.counted_quantity === null && ' · não contado'}
                    </span>
                  </TD>
                  <TD className="text-right tabular-nums">{item.expected_quantity !== null ? formatQuantity(item.expected_quantity) : '—'}</TD>
                  <TD className="text-right tabular-nums">{item.counted_quantity !== null ? formatQuantity(item.counted_quantity) : '—'}</TD>
                  <TD className={cn('text-right font-semibold tabular-nums', has && diff! < 0 && 'text-destructive', has && diff! > 0 && 'text-success')}>
                    {diff === null ? '—' : has ? `${diff > 0 ? '+' : ''}${formatQuantity(diff)}` : '0'}
                  </TD>
                  <TD className="pr-4 text-right tabular-nums">
                    {has && item.unit_cost !== null ? formatMoney(Math.round(diff! * item.unit_cost * 100) / 100) : '—'}
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
        {pending && (
          <CardContent className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
            <span className="text-sm text-muted-foreground">
              O ajuste é pela diferença: venda feita depois da contagem continua valendo. O que não for marcado fica como está.
            </span>
            <Button className="ml-auto" onClick={() => setNoteOpen(true)}>
              {adjust.size ? `Aprovar ${adjust.size} ${adjust.size === 1 ? 'ajuste' : 'ajustes'}` : 'Conferir sem ajustar'}
            </Button>
          </CardContent>
        )}
      </Card>
      {data.count.review_note && <p className="mt-3 text-sm text-muted-foreground">Observação: {data.count.review_note}</p>}
      <ReasonDialog
        open={noteOpen}
        onOpenChange={setNoteOpen}
        title="Aprovar a conferência"
        description={adjust.size ? `Os ajustes entram no extrato de cada produto como "Contagem nº ${data.count.id}".` : 'Nenhum produto será ajustado.'}
        confirmLabel="Aprovar"
        destructive={false}
        suggestions={['Quebra no manuseio', 'Erro de lançamento', 'Furto', 'Recontado e confirmado']}
        loading={review.isPending}
        onConfirm={(note) => review.mutate(note)}
      />
    </>
  );
}

export function StockCountPage() {
  const id = Number(useParams().id);
  useDocumentTitle(`Contagem nº ${id}`);
  const user = useUser();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['routines', 'count', id],
    queryFn: () => api<StockCountDetail>(`/stock-counts/${id}`),
  });
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['routines'] });
    queryClient.invalidateQueries({ queryKey: ['stock'] });
  };
  // Ao voltar para a aba, recarrega (outra pessoa pode estar contando junto).
  useEffect(() => {
    const onFocus = () => queryClient.invalidateQueries({ queryKey: ['routines', 'count', id] });
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [id, queryClient]);

  if (query.isPending) return <Skeleton className="h-64" />;
  if (!query.data) return <Alert variant="danger" title="Contagem não encontrada." />;
  const data = query.data;
  const status = COUNT_STATUS[data.count.status];
  return (
    <div className="mx-auto max-w-3xl">
      <Link to="/rotinas?aba=contagens" className="mb-3 inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" />
        Contagens
      </Link>
      <div className="mb-4 grid gap-1">
        <h1 className="flex flex-wrap items-center gap-2 text-2xl font-bold tracking-tight">
          Contagem nº {data.count.id}
          <Badge variant={status.variant}>{status.label}</Badge>
        </h1>
        <p className="text-sm text-muted-foreground">
          {data.count.store_name} · aberta em {formatDateTime(data.count.created_at)} por {data.count.user_name} ·{' '}
          {data.count.mode === 'cycle' ? 'escolhida pela curva ABC' : 'produtos escolhidos'}
          {data.count.reviewed_by_name && ` · conferida por ${data.count.reviewed_by_name}`}
        </p>
      </div>
      {data.count.status === 'counting' ? (
        <Counting data={data} onChanged={refresh} />
      ) : data.reveal ? (
        <Review data={data} onChanged={refresh} />
      ) : data.count.status === 'cancelled' ? (
        <Alert variant="danger" title="Contagem cancelada." />
      ) : (
        <Card>
          <CardContent className="grid gap-2 pt-5 text-sm">
            <p className="font-medium">
              {data.count.status === 'submitted' ? 'Enviada para conferência.' : 'Conferida pelo administrador.'}
            </p>
            <p className="text-muted-foreground">
              {data.items.filter((i) => i.counted_quantity !== null).length} de {data.items.length} produtos contados.
              {user.role !== 'admin' && ' O resultado (esperado e diferença) fica com o administrador.'}
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

