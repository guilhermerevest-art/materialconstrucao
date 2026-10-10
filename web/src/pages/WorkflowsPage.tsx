import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Check, Copy, Flag, Pencil, Plus, RotateCcw, Sparkles, Trash2, X } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { toast } from 'sonner';
import { EmptyState, PageHeader } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Label, NativeSelect, Textarea } from '@/components/ui/input';
import { Alert, Badge, Skeleton } from '@/components/ui/misc';
import { api, ApiError } from '@/lib/api';
import { useDocumentTitle } from '@/lib/hooks';
import type { DeliveryType, Sector, Store, Workflow, WorkflowStage } from '@/lib/types';
import { cn } from '@/lib/utils';
import { DELIVERY_LABEL, MESSAGE_PLACEHOLDERS } from '@/lib/workflow';

const errorMessage = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

function SectorsCard({ sectors }: { sectors: Sector[] }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<{ id: number; name: string } | null>(null);
  const [deleting, setDeleting] = useState<Sector | null>(null);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['sectors'] });
    queryClient.invalidateQueries({ queryKey: ['workflows'] });
  };

  const create = useMutation({
    mutationFn: () => api('/sectors', { method: 'POST', body: { name } }),
    onSuccess: () => {
      invalidate();
      setName('');
      toast.success('Setor cadastrado.');
    },
    onError: (err) => toast.error(errorMessage(err, 'Não foi possível cadastrar.')),
  });

  const rename = useMutation({
    mutationFn: (sector: { id: number; name: string }) => api(`/sectors/${sector.id}`, { method: 'PUT', body: { name: sector.name } }),
    onSuccess: () => {
      invalidate();
      setEditing(null);
    },
    onError: (err) => toast.error(errorMessage(err, 'Não foi possível renomear.')),
  });

  const remove = useMutation({
    mutationFn: (sector: Sector) => api(`/sectors/${sector.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      invalidate();
      setDeleting(null);
      toast.success('Setor excluído.');
    },
    onError: (err) => {
      toast.error(errorMessage(err, 'Não foi possível excluir.'));
      setDeleting(null);
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (name.trim()) create.mutate();
  }

  return (
    <Card>
      <CardHeader>
        <div className="grid gap-0.5">
          <CardTitle>Setores</CardTitle>
          <CardDescription>
            Áreas que cuidam das etapas. Cada setor tem o seu monitor, e só quem é do setor tira o pedido das etapas dele.
            Escolha os setores de cada pessoa em Administração → Vendedores.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="grid gap-3">
        {sectors.length > 0 && (
          <ul className="divide-y divide-border rounded-md border border-border">
            {sectors.map((sector) => (
              <li key={sector.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                {editing?.id === sector.id ? (
                  <form
                    className="flex flex-1 items-center gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      rename.mutate(editing);
                    }}
                  >
                    <Input
                      aria-label="Nome do setor"
                      value={editing.name}
                      onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                      maxLength={40}
                      autoFocus
                      className="h-8 max-w-60"
                    />
                    <Button type="submit" size="sm" loading={rename.isPending}>
                      <Check />
                      Salvar
                    </Button>
                    <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(null)}>
                      Cancelar
                    </Button>
                  </form>
                ) : (
                  <>
                    <span className="font-medium">{sector.name}</span>
                    <span className="text-[13px] text-muted-foreground">
                      {sector.users_count} {sector.users_count === 1 ? 'pessoa' : 'pessoas'} · {sector.stages_count}{' '}
                      {sector.stages_count === 1 ? 'etapa' : 'etapas'}
                    </span>
                    <div className="ml-auto flex gap-1">
                      <Button variant="ghost" size="sm" onClick={() => setEditing({ id: sector.id, name: sector.name })}>
                        <Pencil />
                        Renomear
                      </Button>
                      <Button
                        variant="destructive-ghost"
                        size="icon"
                        className="size-8"
                        onClick={() => setDeleting(sector)}
                        aria-label={`Excluir ${sector.name}`}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
          <Input
            aria-label="Novo setor"
            placeholder="Ex.: Faturamento, Separação, Expedição"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={40}
            className="max-w-80"
          />
          <Button type="submit" variant="outline" loading={create.isPending} disabled={!name.trim()}>
            <Plus />
            Adicionar setor
          </Button>
        </form>
      </CardContent>
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Excluir o setor ${deleting?.name}?`}
        description="As pessoas deixam de fazer parte dele. Setor usado em alguma etapa não pode ser excluído."
        confirmLabel="Excluir"
        destructive
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </Card>
  );
}

type DraftStage = {
  key: string;
  id?: number;
  name: string;
  sector_id: string;
  sla: string;
  notify: boolean;
  message: string;
  orders_count: number;
};

let draftKey = 0;
const nextKey = () => `nova-${++draftKey}`;

function toDraft(stage: WorkflowStage): DraftStage {
  return {
    key: `etapa-${stage.id}`,
    id: stage.id,
    name: stage.name,
    sector_id: stage.sector_id ? String(stage.sector_id) : '',
    sla: stage.sla_minutes ? String(stage.sla_minutes) : '',
    notify: Boolean(stage.whatsapp_message),
    message: stage.whatsapp_message ?? '',
    orders_count: stage.orders_count,
  };
}

const blankStage = (name = ''): DraftStage => ({
  key: nextKey(),
  name,
  sector_id: '',
  sla: '',
  notify: false,
  message: '',
  orders_count: 0,
});

/** Lista editável das etapas. Monta de novo (key) quando o fluxo salvo muda. */
function StageEditor({
  initial,
  sectors,
  saving,
  onSave,
  footer,
}: {
  initial: DraftStage[];
  sectors: Sector[];
  saving: boolean;
  onSave: (stages: DraftStage[]) => void;
  footer?: ReactNode;
}) {
  const [stages, setStages] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const dirty = JSON.stringify(stages) !== JSON.stringify(initial);

  const update = (key: string, patch: Partial<DraftStage>) =>
    setStages((current) => current.map((stage) => (stage.key === key ? { ...stage, ...patch } : stage)));

  const moveStage = (index: number, delta: number) =>
    setStages((current) => {
      const next = [...current];
      const [stage] = next.splice(index, 1);
      next.splice(index + delta, 0, stage!);
      return next;
    });

  // Etapa nova entra antes da final: a final costuma ser "Entregue" ou "Retirado".
  const addStage = () =>
    setStages((current) => (current.length ? [...current.slice(0, -1), blankStage(), current.at(-1)!] : [blankStage()]));

  function submit(event: FormEvent) {
    event.preventDefault();
    if (stages.length < 2) return setError('O fluxo precisa de pelo menos duas etapas: uma de trabalho e a final.');
    const empty = stages.findIndex((s) => s.name.trim().length < 2);
    if (empty >= 0) return setError(`Dê um nome à etapa ${empty + 1}.`);
    const badSla = stages.find((s) => s.sla.trim() && !/^\d+$/.test(s.sla.trim()));
    if (badSla) return setError(`O tempo esperado de "${badSla.name}" precisa ser em minutos inteiros.`);
    const noMessage = stages.find((s, i) => i > 0 && s.notify && !s.message.trim());
    if (noMessage) return setError(`Escreva a mensagem de WhatsApp de "${noMessage.name}" ou desmarque o aviso.`);
    setError(null);
    onSave(stages);
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      {error && <Alert variant="danger" title={error} />}
      <ol className="grid gap-3">
        {stages.map((stage, index) => {
          const isFirst = index === 0;
          const isFinal = index === stages.length - 1 && stages.length > 1;
          const prefix = `etapa-${stage.key}`;
          return (
            <li key={stage.key} className={cn('rounded-lg border border-border p-3', isFinal && 'bg-muted/60')}>
              <div className="flex flex-wrap items-end gap-3">
                <span
                  className={cn(
                    'grid size-8 shrink-0 place-items-center self-center rounded-full text-sm font-bold',
                    isFinal ? 'bg-success-soft text-success' : 'bg-steel text-white',
                  )}
                  aria-hidden
                >
                  {isFinal ? <Flag className="size-4" /> : index + 1}
                </span>
                <Field label="Etapa" htmlFor={`${prefix}-nome`} className="min-w-48 flex-[2]">
                  <Input
                    id={`${prefix}-nome`}
                    value={stage.name}
                    onChange={(e) => update(stage.key, { name: e.target.value })}
                    maxLength={40}
                    placeholder={isFinal ? 'Ex.: Entregue' : 'Ex.: Em separação'}
                  />
                </Field>
                {!isFinal && (
                  <>
                    <Field label="Setor responsável" htmlFor={`${prefix}-setor`} className="min-w-40 flex-1">
                      <NativeSelect
                        id={`${prefix}-setor`}
                        value={stage.sector_id}
                        onChange={(e) => update(stage.key, { sector_id: e.target.value })}
                      >
                        <option value="">Qualquer pessoa da loja</option>
                        {sectors.map((sector) => (
                          <option key={sector.id} value={sector.id}>
                            {sector.name}
                          </option>
                        ))}
                      </NativeSelect>
                    </Field>
                    <Field label="Prazo (min)" htmlFor={`${prefix}-sla`} className="w-32">
                      <Input
                        id={`${prefix}-sla`}
                        inputMode="numeric"
                        value={stage.sla}
                        onChange={(e) => update(stage.key, { sla: e.target.value.replace(/\D/g, '') })}
                        placeholder="Sem prazo"
                        maxLength={5}
                      />
                    </Field>
                  </>
                )}
                <div className="ml-auto flex items-center gap-1 self-center pt-5">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    disabled={index === 0}
                    onClick={() => moveStage(index, -1)}
                    aria-label={`Subir ${stage.name || 'etapa'}`}
                  >
                    <ArrowUp />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    disabled={index === stages.length - 1}
                    onClick={() => moveStage(index, 1)}
                    aria-label={`Descer ${stage.name || 'etapa'}`}
                  >
                    <ArrowDown />
                  </Button>
                  <Button
                    type="button"
                    variant="destructive-ghost"
                    size="icon"
                    className="size-8"
                    disabled={stage.orders_count > 0}
                    title={
                      stage.orders_count > 0
                        ? `${stage.orders_count} ${stage.orders_count === 1 ? 'pedido está' : 'pedidos estão'} nesta etapa`
                        : undefined
                    }
                    onClick={() => setStages((current) => current.filter((s) => s.key !== stage.key))}
                    aria-label={`Remover ${stage.name || 'etapa'}`}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 pl-11 text-[13px] text-muted-foreground">
                {isFinal && <span>Etapa final: o pedido que chega aqui está concluído e sai dos monitores.</span>}
                {stage.orders_count > 0 && (
                  <Badge variant="order">
                    {stage.orders_count} {stage.orders_count === 1 ? 'pedido aqui' : 'pedidos aqui'}
                  </Badge>
                )}
              </div>

              {!isFirst && (
                <div className="mt-2 grid gap-2 pl-11">
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox checked={stage.notify} onChange={(e) => update(stage.key, { notify: e.target.checked })} />
                    Avisar o cliente pelo WhatsApp quando o pedido chegar nesta etapa
                  </label>
                  {stage.notify && (
                    <div className="grid gap-1.5">
                      <Label htmlFor={`${prefix}-mensagem`} className="sr-only">
                        Mensagem
                      </Label>
                      <Textarea
                        id={`${prefix}-mensagem`}
                        value={stage.message}
                        onChange={(e) => update(stage.key, { message: e.target.value })}
                        maxLength={500}
                        rows={2}
                        placeholder="Olá, {cliente}! Seu pedido nº {pedido} saiu para entrega."
                      />
                      <p className="text-[13px] text-muted-foreground">Use {MESSAGE_PLACEHOLDERS}. O sistema troca pelos dados do pedido.</p>
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" onClick={addStage}>
          <Plus />
          Adicionar etapa
        </Button>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {dirty && <span className="text-[13px] font-medium text-warning">Alterações não salvas</span>}
          {footer}
          <Button type="submit" loading={saving} disabled={!dirty && initial.every((s) => s.id !== undefined)}>
            Salvar fluxo
          </Button>
        </div>
      </div>
    </form>
  );
}

/** Etapas do modelo da lojamestre, só para ler. */
function StagePreview({ workflow, sectors }: { workflow: Workflow; sectors: Sector[] }) {
  return (
    <ol className="flex flex-wrap items-center gap-2 text-sm">
      {workflow.stages.map((stage, index) => {
        const sector = sectors.find((s) => s.id === stage.sector_id);
        const isFinal = index === workflow.stages.length - 1;
        return (
          <li key={stage.id} className="flex items-center gap-2">
            <span className={cn('rounded-md border border-border px-2.5 py-1.5', isFinal ? 'bg-success-soft' : 'bg-card')}>
              <span className="font-medium">{stage.name}</span>
              {sector && <span className="ml-1.5 text-muted-foreground">· {sector.name}</span>}
            </span>
            {!isFinal && <span className="text-muted-foreground">→</span>}
          </li>
        );
      })}
    </ol>
  );
}

export function WorkflowsPage() {
  useDocumentTitle('Fluxo de pedidos');
  const queryClient = useQueryClient();
  const [scope, setScope] = useState<string>('modelo');
  const [type, setType] = useState<DeliveryType>('pickup');
  const [startBlank, setStartBlank] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'import' | 'delete' | null>(null);

  const workflows = useQuery({
    queryKey: ['workflows'],
    queryFn: () => api<{ items: Workflow[] }>('/workflows').then((r) => r.items),
  });
  const sectors = useQuery({
    queryKey: ['sectors'],
    queryFn: () => api<{ items: Sector[] }>('/sectors').then((r) => r.items),
  });
  const stores = useQuery({
    queryKey: ['stores'],
    queryFn: () => api<{ items: Store[] }>('/stores').then((r) => r.items),
  });

  const storeId = scope === 'modelo' ? null : Number(scope);
  const store = stores.data?.find((s) => s.id === storeId);
  const template = workflows.data?.find((w) => w.store_id === null && w.delivery_type === type);
  const own = storeId === null ? template : workflows.data?.find((w) => w.store_id === storeId && w.delivery_type === type);
  const hasAnyTemplate = workflows.data?.some((w) => w.store_id === null) ?? false;
  const scopeKey = `${scope}-${type}`;

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['workflows'] });
    queryClient.invalidateQueries({ queryKey: ['sectors'] });
  };

  const save = useMutation({
    mutationFn: (stages: DraftStage[]) =>
      api<{ workflow: Workflow }>('/workflows', {
        method: 'PUT',
        body: {
          store_id: storeId,
          delivery_type: type,
          stages: stages.map((stage, index) => {
            const isFinal = index === stages.length - 1;
            return {
              id: stage.id,
              name: stage.name.trim(),
              sector_id: !isFinal && stage.sector_id ? Number(stage.sector_id) : null,
              sla_minutes: !isFinal && stage.sla.trim() ? Number(stage.sla) : null,
              whatsapp_message: index > 0 && stage.notify ? stage.message.trim() : null,
            };
          }),
        },
      }),
    onSuccess: () => {
      invalidate();
      setStartBlank(null);
      toast.success('Fluxo salvo. Vale para os pedidos confirmados daqui em diante.');
    },
    onError: (err) => toast.error(errorMessage(err, 'Não foi possível salvar o fluxo.')),
  });

  const importTemplate = useMutation({
    mutationFn: () => api('/workflows/import', { method: 'POST', body: { store_id: storeId, delivery_type: type } }),
    onSuccess: () => {
      invalidate();
      setConfirm(null);
      toast.success(`Fluxo da lojamestre copiado para ${store?.name}. Agora ajuste como quiser.`);
    },
    onError: (err) => {
      setConfirm(null);
      toast.error(errorMessage(err, 'Não foi possível importar.'));
    },
  });

  const suggested = useMutation({
    mutationFn: () => api('/workflows/suggested', { method: 'POST' }),
    onSuccess: () => {
      invalidate();
      toast.success('Fluxo sugerido criado. Revise as etapas e os setores.');
    },
    onError: (err) => toast.error(errorMessage(err, 'Não foi possível criar o fluxo sugerido.')),
  });

  const remove = useMutation({
    mutationFn: (id: number) => api(`/workflows/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      invalidate();
      setConfirm(null);
      toast.success(storeId === null ? 'Fluxo excluído.' : `${store?.name} voltou a usar o fluxo da lojamestre.`);
    },
    onError: (err) => {
      setConfirm(null);
      toast.error(errorMessage(err, 'Não foi possível excluir o fluxo.'));
    },
  });

  if (workflows.isPending || sectors.isPending || stores.isPending) {
    return (
      <div className="grid gap-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-40" />
        <Skeleton className="h-72" />
      </div>
    );
  }

  const sectorList = sectors.data ?? [];
  const label = DELIVERY_LABEL[type].toLowerCase();

  function body() {
    if (own) {
      return (
        <StageEditor
          key={`${scopeKey}-${own.id}-${own.updated_at}`}
          initial={own.stages.map(toDraft)}
          sectors={sectorList}
          saving={save.isPending}
          onSave={(stages) => save.mutate(stages)}
          footer={
            storeId === null ? (
              <Button type="button" variant="destructive-ghost" onClick={() => setConfirm('delete')}>
                <Trash2 />
                Excluir fluxo
              </Button>
            ) : (
              <>
                {template && (
                  <Button type="button" variant="ghost" onClick={() => setConfirm('import')}>
                    <Copy />
                    Copiar de novo da lojamestre
                  </Button>
                )}
                <Button type="button" variant="ghost" onClick={() => setConfirm('delete')}>
                  <RotateCcw />
                  Usar o da lojamestre
                </Button>
              </>
            )
          }
        />
      );
    }

    if (startBlank === scopeKey) {
      return (
        <StageEditor
          key={`${scopeKey}-novo`}
          initial={[blankStage(), blankStage(type === 'pickup' ? 'Retirado' : 'Entregue')]}
          sectors={sectorList}
          saving={save.isPending}
          onSave={(stages) => save.mutate(stages)}
          footer={
            <Button type="button" variant="ghost" onClick={() => setStartBlank(null)}>
              <X />
              Cancelar
            </Button>
          }
        />
      );
    }

    const blankButton = (
      <Button variant="outline" onClick={() => setStartBlank(scopeKey)}>
        <Plus />
        {storeId === null ? 'Montar do zero' : 'Montar um fluxo só desta loja'}
      </Button>
    );

    if (storeId === null) {
      return (
        <EmptyState
          title={`Sem fluxo de ${label}`}
          description={
            hasAnyTemplate
              ? `Pedidos de ${label} confirmados não passam por etapas.`
              : 'Monte as etapas que o pedido percorre depois de confirmado. Sem fluxo, nada muda: o pedido não passa por etapas.'
          }
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button onClick={() => suggested.mutate()} loading={suggested.isPending}>
                <Sparkles />
                Começar com o fluxo sugerido
              </Button>
              {blankButton}
            </div>
          }
        />
      );
    }

    return (
      <div className="grid gap-4">
        {template ? (
          <>
            <Alert variant="info" title={`${store?.name} usa o fluxo de ${label} da lojamestre.`}>
              <p className="text-muted-foreground">
                Mudanças no modelo valem para esta loja. Para ter etapas diferentes, copie o modelo e ajuste.
              </p>
            </Alert>
            <StagePreview workflow={template} sectors={sectorList} />
          </>
        ) : (
          <Alert variant="info" title={`A lojamestre não tem fluxo de ${label}.`}>
            <p className="text-muted-foreground">Pedidos de {label} desta loja não passam por etapas.</p>
          </Alert>
        )}
        <div className="flex flex-wrap gap-2">
          {template && (
            <Button onClick={() => importTemplate.mutate()} loading={importTemplate.isPending}>
              <Copy />
              Personalizar para esta loja
            </Button>
          )}
          {blankButton}
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-6">
      <PageHeader
        className="mb-0"
        title="Fluxo de pedidos"
        description="Etapas que o pedido percorre depois de confirmado, por loja e por tipo de entrega. Orçamentos não entram no fluxo."
      />

      <SectorsCard sectors={sectorList} />

      <Card>
        <CardHeader className="items-end">
          <Field label="Fluxo de" htmlFor="fluxo-escopo" className="min-w-60">
            <NativeSelect id="fluxo-escopo" value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="modelo">Lojamestre (modelo para todas as lojas)</option>
              {(stores.data ?? []).map((s) => {
                const custom = workflows.data?.some((w) => w.store_id === s.id);
                return (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {custom ? ' (fluxo próprio)' : ''}
                  </option>
                );
              })}
            </NativeSelect>
          </Field>
          <div role="tablist" aria-label="Tipo de entrega" className="flex rounded-md border border-input bg-muted p-1">
            {(['pickup', 'delivery'] as const).map((value) => (
              <button
                key={value}
                role="tab"
                aria-selected={type === value}
                onClick={() => setType(value)}
                className={cn(
                  'rounded px-3 py-1.5 text-sm font-medium',
                  type === value ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {DELIVERY_LABEL[value]}
              </button>
            ))}
          </div>
        </CardHeader>
        <CardContent>{body()}</CardContent>
      </Card>

      <ConfirmDialog
        open={confirm === 'import'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title="Copiar de novo o fluxo da lojamestre?"
        description={`As etapas de ${label} de ${store?.name} serão trocadas pelas do modelo. Só funciona se nenhum pedido estiver nelas agora.`}
        confirmLabel="Copiar"
        loading={importTemplate.isPending}
        onConfirm={() => importTemplate.mutate()}
      />
      <ConfirmDialog
        open={confirm === 'delete'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={storeId === null ? `Excluir o fluxo de ${label} da lojamestre?` : `Voltar a usar o fluxo da lojamestre?`}
        description={
          storeId === null
            ? `Lojas sem fluxo próprio deixam de ter etapas nos pedidos de ${label}. Só funciona se nenhum pedido estiver no fluxo agora.`
            : `${store?.name} perde as etapas próprias de ${label} e passa a seguir o modelo. Só funciona se nenhum pedido estiver nelas agora.`
        }
        confirmLabel={storeId === null ? 'Excluir' : 'Usar o da lojamestre'}
        destructive={storeId === null}
        loading={remove.isPending}
        onConfirm={() => own && remove.mutate(own.id)}
      />
    </div>
  );
}
