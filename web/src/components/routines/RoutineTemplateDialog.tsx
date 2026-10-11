import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { WEEKDAY_OPTIONS } from '@/lib/routines';
import type { RoutineAction, RoutineFrequency, RoutineItemKind, RoutineTemplate, Store } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { Checkbox, Field, Input, NativeSelect } from '../ui/input';
import { Alert } from '../ui/misc';

type ItemForm = { key: number; label: string; hint: string; kind: RoutineItemKind; required: boolean; action: RoutineAction | '' };

const KIND_LABEL: Record<RoutineItemKind, string> = { check: 'Marcar feito', number: 'Número', text: 'Texto', photo: 'Foto' };

let nextKey = 1;
const newItem = (): ItemForm => ({ key: nextKey++, label: '', hint: '', kind: 'check', required: true, action: '' });

/** Cria ou edita o modelo da rotina: agenda, horário, loja e os itens do checklist. */
export function RoutineTemplateDialog({
  open,
  onOpenChange,
  template,
  stores,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  template: RoutineTemplate | null;
  stores: Store[];
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [frequency, setFrequency] = useState<RoutineFrequency>('weekly');
  const [weekdays, setWeekdays] = useState<number[]>([1, 2, 3, 4, 5, 6]);
  const [monthDay, setMonthDay] = useState('1');
  const [dueTime, setDueTime] = useState('');
  const [storeId, setStoreId] = useState('');
  const [active, setActive] = useState(true);
  const [items, setItems] = useState<ItemForm[]>([]);
  const [error, setError] = useState<string | null>(null);
  const isCount = template?.kind === 'stock_count';

  useEffect(() => {
    if (!open) return;
    setName(template?.name ?? '');
    setDescription(template?.description ?? '');
    setFrequency(template?.frequency ?? 'weekly');
    setWeekdays(template?.weekdays.length ? template.weekdays : [1, 2, 3, 4, 5, 6]);
    setMonthDay(String(template?.month_day ?? 1));
    setDueTime(template?.due_time ?? '');
    setStoreId(template?.store_id ? String(template.store_id) : '');
    setActive(template?.active ?? true);
    setItems(
      template
        ? template.items.map((i) => ({ key: nextKey++, label: i.label, hint: i.hint ?? '', kind: i.kind, required: i.required, action: i.action ?? '' }))
        : [newItem()],
    );
    setError(null);
  }, [open, template]);

  const update = (key: number, patch: Partial<ItemForm>) => setItems((list) => list.map((i) => (i.key === key ? { ...i, ...patch } : i)));
  const move = (index: number, delta: number) =>
    setItems((list) => {
      const next = [...list];
      const [item] = next.splice(index, 1);
      next.splice(index + delta, 0, item!);
      return next;
    });

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name,
        kind: template?.kind ?? 'checklist',
        description: description || null,
        frequency,
        weekdays,
        month_day: frequency === 'monthly' ? Number(monthDay) : null,
        due_time: frequency === 'on_demand' || !dueTime ? null : dueTime,
        store_id: storeId ? Number(storeId) : null,
        active,
        items: isCount
          ? []
          : items.map((i) => ({ label: i.label, hint: i.hint || null, kind: i.kind, required: i.required, action: i.kind === 'check' && i.action ? i.action : null })),
      };
      return template
        ? api(`/routines/templates/${template.id}`, { method: 'PUT', body })
        : api('/routines/templates', { method: 'POST', body });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['routines'] });
      toast.success(template ? 'Modelo salvo.' : 'Modelo criado.');
      onOpenChange(false);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Não foi possível salvar.'),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (name.trim().length < 2) return setError('Informe o nome da rotina.');
    if (frequency === 'weekly' && !weekdays.length) return setError('Escolha os dias da semana.');
    if (!isCount && !items.some((i) => i.label.trim())) return setError('Inclua pelo menos um item.');
    if (!isCount && items.some((i) => i.label.trim().length < 2)) return setError('Escreva cada item (ou remova os vazios).');
    setError(null);
    save.mutate();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{template ? 'Editar rotina' : 'Nova rotina'}</DialogTitle>
          <DialogDescription>
            {isCount
              ? 'A contagem escolhe os produtos sozinha (curva ABC). Aqui fica só a agenda.'
              : 'O que já foi feito guarda os itens da época: mudar aqui vale das próximas em diante.'}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          {error && <Alert variant="danger" title={error} />}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Nome" htmlFor="rotina-nome">
              <Input id="rotina-nome" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
            </Field>
            <Field label="Loja" htmlFor="rotina-loja">
              <NativeSelect id="rotina-loja" value={storeId} onChange={(e) => setStoreId(e.target.value)}>
                <option value="">Todas as lojas</option>
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          </div>
          <Field label="Descrição" htmlFor="rotina-descricao">
            <Input id="rotina-descricao" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} placeholder="Opcional" />
          </Field>
          <div className="grid gap-4 sm:grid-cols-[12rem_1fr]">
            <Field label="Quando" htmlFor="rotina-frequencia">
              <NativeSelect id="rotina-frequencia" value={frequency} onChange={(e) => setFrequency(e.target.value as RoutineFrequency)}>
                <option value="weekly">Dias da semana</option>
                <option value="monthly">Um dia do mês</option>
                <option value="on_demand">Quando precisar</option>
              </NativeSelect>
            </Field>
            {frequency === 'weekly' && (
              <div className="grid gap-1.5">
                <span className="text-sm font-medium">Dias</span>
                <div className="flex flex-wrap gap-1" role="group" aria-label="Dias da semana">
                  {WEEKDAY_OPTIONS.map((d) => (
                    <button
                      key={d.value}
                      type="button"
                      aria-pressed={weekdays.includes(d.value)}
                      onClick={() => setWeekdays((w) => (w.includes(d.value) ? w.filter((x) => x !== d.value) : [...w, d.value]))}
                      className={cn(
                        'h-10 w-11 rounded-md border text-sm font-medium',
                        weekdays.includes(d.value) ? 'border-primary bg-primary-soft text-foreground' : 'border-input text-muted-foreground',
                      )}
                    >
                      {d.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {frequency === 'monthly' && (
              <Field label="Dia do mês" htmlFor="rotina-dia" className="w-32">
                <Input id="rotina-dia" type="number" min={1} max={28} value={monthDay} onChange={(e) => setMonthDay(e.target.value)} />
              </Field>
            )}
          </div>
          {frequency !== 'on_demand' && (
            <Field label="Até que horas" htmlFor="rotina-hora" hint="Depois disso, aparece como atrasada. Em branco, vale o dia todo." className="w-48">
              <Input id="rotina-hora" type="time" value={dueTime} onChange={(e) => setDueTime(e.target.value)} />
            </Field>
          )}

          {!isCount && (
            <fieldset className="grid gap-2">
              <legend className="mb-1 text-sm font-medium">Itens</legend>
              <ol className="grid gap-2">
                {items.map((item, index) => (
                  <li key={item.key} className="grid gap-2 rounded-md border border-border p-3">
                    <div className="flex items-start gap-2">
                      <span className="mt-2.5 w-5 text-right text-sm text-muted-foreground tabular-nums">{index + 1}.</span>
                      <Input
                        aria-label={`Item ${index + 1}`}
                        value={item.label}
                        onChange={(e) => update(item.key, { label: e.target.value })}
                        maxLength={160}
                        placeholder="Ex.: Portas trancadas e alarme ligado"
                        className="min-w-0 flex-1"
                      />
                      <div className="flex shrink-0">
                        <Button type="button" variant="ghost" size="icon" className="size-10" disabled={index === 0} onClick={() => move(index, -1)} aria-label="Subir">
                          <ArrowUp />
                        </Button>
                        <Button type="button" variant="ghost" size="icon" className="size-10" disabled={index === items.length - 1} onClick={() => move(index, 1)} aria-label="Descer">
                          <ArrowDown />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-10"
                          disabled={items.length === 1}
                          onClick={() => setItems((list) => list.filter((i) => i.key !== item.key))}
                          aria-label="Remover item"
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-3 pl-7">
                      <NativeSelect
                        aria-label={`Tipo do item ${index + 1}`}
                        value={item.kind}
                        onChange={(e) => update(item.key, { kind: e.target.value as RoutineItemKind, action: '' })}
                        className="h-9 w-40"
                      >
                        {(Object.keys(KIND_LABEL) as RoutineItemKind[]).map((k) => (
                          <option key={k} value={k}>
                            {KIND_LABEL[k]}
                          </option>
                        ))}
                      </NativeSelect>
                      {item.kind === 'check' && (
                        <NativeSelect
                          aria-label={`Conferido pelo sistema (item ${index + 1})`}
                          value={item.action}
                          onChange={(e) => update(item.key, { action: e.target.value as ItemForm['action'] })}
                          className="h-9 w-56"
                        >
                          <option value="">Quem faz marca</option>
                          <option value="cash_open">Sistema confere: caixa aberto hoje</option>
                          <option value="cash_closed">Sistema confere: caixas fechados</option>
                        </NativeSelect>
                      )}
                      <label className="flex items-center gap-2 text-sm">
                        <Checkbox checked={item.required} onChange={(e) => update(item.key, { required: e.target.checked })} />
                        Obrigatório
                      </label>
                    </div>
                  </li>
                ))}
              </ol>
              <Button type="button" variant="outline" size="sm" className="justify-self-start" onClick={() => setItems((list) => [...list, newItem()])}>
                <Plus />
                Item
              </Button>
            </fieldset>
          )}

          {template && (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={active} onChange={(e) => setActive(e.target.checked)} />
              Ativa (desmarque para parar de aparecer na agenda)
            </label>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" loading={save.isPending}>
              Salvar
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
