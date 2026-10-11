import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Camera, Check, CheckCircle2, ScanBarcode, TriangleAlert, X } from 'lucide-react';
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input, Textarea } from '@/components/ui/input';
import { Alert, Badge, Skeleton } from '@/components/ui/misc';
import { api, ApiError } from '@/lib/api';
import { decimalToInput, formatDateTime, formatDay, parseDecimal } from '@/lib/format';
import { useDocumentTitle } from '@/lib/hooks';
import { compressPhoto } from '@/lib/photo';
import { COUNT_STATUS } from '@/lib/routines';
import type { RoutineRun, RoutineRunItem } from '@/lib/types';
import { cn } from '@/lib/utils';

type Patch = { checked?: boolean; value_number?: number | null; value_text?: string | null; photo?: string | null };

/** O que o sistema diz do caixa, para os itens que ele confere. */
function cashMessage(item: RoutineRunItem, run: RoutineRun) {
  if (!item.action || !run.cash) return null;
  if (item.action === 'cash_open') return run.cash.opened_today ? 'Caixa aberto hoje nesta loja.' : 'Nenhum caixa aberto hoje nesta loja.';
  return run.cash.open_now ? 'Ainda há caixa aberto nesta loja.' : run.cash.closed_today ? 'Todos os caixas de hoje estão fechados.' : 'Nenhum caixa aberto nesta loja.';
}

function ItemRow({ item, run, readOnly, onSave }: { item: RoutineRunItem; run: RoutineRun; readOnly: boolean; onSave: (patch: Patch) => Promise<void> }) {
  const [text, setText] = useState(item.value_text ?? '');
  const [number, setNumber] = useState(item.value_number !== null ? decimalToInput(item.value_number) : '');
  const [busy, setBusy] = useState(false);
  const photoInput = useRef<HTMLInputElement>(null);
  useEffect(() => setText(item.value_text ?? ''), [item.value_text]);
  useEffect(() => setNumber(item.value_number !== null ? decimalToInput(item.value_number) : ''), [item.value_number]);

  const systemChecked = item.satisfied !== null;
  const done =
    item.kind === 'check'
      ? systemChecked
        ? item.satisfied
        : item.checked
      : item.kind === 'number'
        ? item.value_number !== null
        : item.kind === 'text'
          ? Boolean(item.value_text)
          : Boolean(item.photo);
  const message = cashMessage(item, run);

  async function save(patch: Patch) {
    setBusy(true);
    try {
      await onSave(patch);
    } finally {
      setBusy(false);
    }
  }

  async function pickPhoto(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      await save({ photo: await compressPhoto(file) });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Não foi possível usar a foto.');
    }
  }

  return (
    <li className="grid gap-2 px-4 py-3 sm:px-5">
      <div className="flex items-start gap-3">
        {item.kind === 'check' && !systemChecked ? (
          <button
            type="button"
            disabled={readOnly || busy}
            onClick={() => save({ checked: !item.checked })}
            aria-pressed={item.checked}
            aria-label={item.label}
            className={cn(
              'grid size-8 shrink-0 place-items-center rounded-md border-2 transition-colors',
              item.checked ? 'border-success bg-success text-white' : 'border-input bg-card',
            )}
          >
            {item.checked && <Check className="size-5" />}
          </button>
        ) : (
          <span className={cn('grid size-8 shrink-0 place-items-center', done ? 'text-success' : 'text-muted-foreground/50')}>
            {done ? <CheckCircle2 className="size-6" /> : systemChecked ? <TriangleAlert className="size-5 text-warning" /> : <span className="size-5 rounded-full border-2 border-current" />}
          </span>
        )}
        <div className="grid min-w-0 flex-1 gap-0.5">
          <p className="font-medium">
            {item.label}
            {!item.required && <span className="ml-2 text-xs font-normal text-muted-foreground">opcional</span>}
          </p>
          {item.hint && <p className="text-[13px] text-muted-foreground">{item.hint}</p>}
          {message && (
            <p className={cn('text-[13px]', item.satisfied ? 'text-success' : 'text-warning')}>
              {message}
              {!item.satisfied && !readOnly && (
                <Link to="/caixa" className="ml-2 font-medium text-primary hover:underline">
                  {item.action === 'cash_open' ? 'Abrir o caixa' : 'Fechar o caixa'}
                </Link>
              )}
            </p>
          )}
          {item.done_at && item.done_by_name && (
            <p className="text-xs text-muted-foreground">
              {item.done_by_name} às {formatDateTime(item.done_at).slice(-5)}
            </p>
          )}
        </div>
      </div>
      {item.kind === 'number' && !(readOnly && item.value_number === null) && (
        <Input
          aria-label={item.label}
          inputMode="decimal"
          value={number}
          disabled={readOnly}
          onChange={(e) => setNumber(e.target.value)}
          onBlur={() => {
            const value = number.trim() ? parseDecimal(number) : null;
            if (number.trim() && value === null) return toast.error('Número inválido.');
            if (value !== item.value_number) void save({ value_number: value });
          }}
          className="ml-11 w-40 text-right tabular-nums"
        />
      )}
      {item.kind === 'text' && !(readOnly && !item.value_text) && (
        <Textarea
          aria-label={item.label}
          rows={2}
          value={text}
          disabled={readOnly}
          maxLength={1000}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => {
            if ((text.trim() || null) !== item.value_text) void save({ value_text: text.trim() || null });
          }}
          className="ml-11 w-auto"
        />
      )}
      {item.kind === 'photo' && (
        <div className="ml-11 flex flex-wrap items-center gap-3">
          {item.photo && (
            <a href={item.photo} target="_blank" rel="noreferrer">
              <img src={item.photo} alt={item.label} className="h-24 rounded-md border border-border object-cover" />
            </a>
          )}
          {!readOnly && (
            <>
              <input ref={photoInput} type="file" accept="image/*" capture="environment" className="hidden" onChange={pickPhoto} />
              <Button type="button" variant="outline" size="sm" loading={busy} onClick={() => photoInput.current?.click()}>
                {!busy && <Camera />}
                {item.photo ? 'Trocar foto' : 'Tirar foto'}
              </Button>
              {item.photo && (
                <Button type="button" variant="ghost" size="sm" onClick={() => save({ photo: null })}>
                  <X />
                  Tirar
                </Button>
              )}
            </>
          )}
        </div>
      )}
    </li>
  );
}

/** Fazer a rotina no celular: cada item salva na hora; concluir confere os obrigatórios. */
export function RoutineRunPage() {
  const id = Number(useParams().id);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['routines', 'run', id],
    queryFn: () => api<{ run: RoutineRun }>(`/routines/runs/${id}`).then((r) => r.run),
  });
  const run = query.data;
  useDocumentTitle(run?.name ?? 'Rotina');
  const [error, setError] = useState<string | null>(null);

  async function saveItem(itemId: number, patch: Patch) {
    try {
      await api(`/routines/runs/${id}/items/${itemId}`, { method: 'PUT', body: patch });
      await queryClient.invalidateQueries({ queryKey: ['routines', 'run', id] });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Não foi possível salvar.');
    }
  }

  const finish = useMutation({
    mutationFn: () => api<{ run: RoutineRun }>(`/routines/runs/${id}/finish`, { method: 'POST', body: {} }),
    onSuccess: ({ run: done }) => {
      queryClient.setQueryData(['routines', 'run', id], done);
      queryClient.invalidateQueries({ queryKey: ['routines'] });
      setError(null);
      toast.success(done.late ? 'Rotina concluída (com atraso).' : 'Rotina concluída.');
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Não foi possível concluir.'),
  });

  if (query.isPending) return <Skeleton className="h-64" />;
  if (!run) return <Alert variant="danger" title="Rotina não encontrada." />;
  const readOnly = run.status === 'done';
  const required = run.items.filter((i) => i.required);
  const doneCount = required.filter((i) =>
    i.kind === 'check' ? (i.satisfied ?? i.checked) : i.kind === 'number' ? i.value_number !== null : i.kind === 'text' ? Boolean(i.value_text) : Boolean(i.photo),
  ).length;

  return (
    <div className="mx-auto max-w-2xl">
      <Link to="/rotinas" className="mb-3 inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" />
        Rotinas
      </Link>
      <div className="mb-4 grid gap-1">
        <h1 className="flex flex-wrap items-center gap-2 text-2xl font-bold tracking-tight">
          {run.name}
          {readOnly ? <Badge variant="success">Feita{run.late ? ' com atraso' : ''}</Badge> : <Badge variant="quote">Em andamento</Badge>}
        </h1>
        <p className="text-sm text-muted-foreground">
          {run.store_name} · {formatDay(run.run_date)}
          {run.due_time && ` · até ${run.due_time}`} · começada por {run.user_name}
        </p>
        {run.description && <p className="text-sm text-muted-foreground">{run.description}</p>}
      </div>

      {run.count && (
        <Card className="mb-4">
          <CardContent className="flex flex-wrap items-center gap-3 pt-5">
            <ScanBarcode className="size-6 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="font-medium">Contagem nº {run.count.id}</span>
              <span className="block text-[13px] text-muted-foreground">
                {run.count.counted} de {run.count.items} produtos contados
              </span>
            </span>
            <Badge variant={COUNT_STATUS[run.count.status].variant}>{COUNT_STATUS[run.count.status].label}</Badge>
            <Button asChild size="sm">
              <Link to={`/rotinas/contagem/${run.count.id}`}>{run.count.status === 'counting' ? 'Contar' : 'Ver'}</Link>
            </Button>
          </CardContent>
        </Card>
      )}

      {run.items.length > 0 && (
        <Card>
          <ul className="divide-y divide-border">
            {run.items.map((item) => (
              <ItemRow key={item.id} item={item} run={run} readOnly={readOnly} onSave={(patch) => saveItem(item.id, patch)} />
            ))}
          </ul>
        </Card>
      )}

      {error && <Alert variant="danger" title={error} className="mt-4" />}
      {readOnly ? (
        <p className="mt-4 text-sm text-muted-foreground">
          Concluída {run.finished_at && `às ${formatDateTime(run.finished_at).slice(-5)}`}
          {run.finished_by_name && ` por ${run.finished_by_name}`}.
        </p>
      ) : (
        <div className="sticky bottom-0 mt-4 flex flex-wrap items-center gap-3 border-t border-border bg-background/95 py-3 backdrop-blur">
          {required.length > 0 && (
            <span className="text-sm text-muted-foreground tabular-nums">
              {doneCount} de {required.length} obrigatórios
            </span>
          )}
          <Button size="lg" className="ml-auto" onClick={() => finish.mutate()} loading={finish.isPending}>
            Concluir
          </Button>
        </div>
      )}
    </div>
  );
}
