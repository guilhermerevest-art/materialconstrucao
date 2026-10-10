import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { MessageCircleReply } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { api, toQuery } from '@/lib/api';
import { useUser } from '@/lib/auth';
import { CHANNEL_LABEL, dueLabel } from '@/lib/followups';
import { formatDateTime, formatDay, formatMoney, formatOrderNumber, formatWhatsapp } from '@/lib/format';
import type { FollowupItem, Paginated } from '@/lib/types';
import { cn } from '@/lib/utils';
import { CancelOrderDialog } from './CancelOrderDialog';
import { FollowupDialog } from './FollowupDialog';
import { EmptyState, Pagination } from './shared';
import { Button } from './ui/button';
import { Skeleton } from './ui/misc';
import { Table, TBody, TD, TH, THead, TR } from './ui/table';

const PAGE_SIZE = 20;

export type FollowupScope = 'due' | 'upcoming';

const SCOPES: { value: FollowupScope; label: string }[] = [
  { value: 'due', label: 'Hoje e atrasados' },
  { value: 'upcoming', label: 'Próximos' },
];

/** Aba "A retomar" dos pedidos: orçamentos para voltar a falar com o cliente. */
export function FollowupList({
  q,
  storeId,
  mine,
  scope,
  onScopeChange,
  page,
  onPageChange,
}: {
  q: string;
  storeId: string;
  mine: boolean;
  scope: FollowupScope;
  onScopeChange: (scope: FollowupScope) => void;
  page: number;
  onPageChange: (page: number) => void;
}) {
  const user = useUser();
  const isAdmin = user.role === 'admin';
  const [contacting, setContacting] = useState<FollowupItem | null>(null);
  const [losing, setLosing] = useState<FollowupItem | null>(null);

  const filters = { scope, q, store_id: storeId, mine: mine ? 'true' : '', page, page_size: PAGE_SIZE };
  const list = useQuery({
    queryKey: ['followups', filters],
    queryFn: () => api<Paginated<FollowupItem> & { days: number }>(`/followups${toQuery(filters)}`),
    placeholderData: keepPreviousData,
  });
  const data = list.data;

  return (
    <>
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
        <div className="flex rounded-md border border-input bg-background p-0.5" role="group" aria-label="Quando">
          {SCOPES.map((option) => (
            <button
              key={option.value}
              onClick={() => onScopeChange(option.value)}
              aria-pressed={scope === option.value}
              className={cn(
                'h-8 rounded px-3 text-sm font-medium whitespace-nowrap',
                scope === option.value ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
        {data && (
          <p className="text-[13px] text-muted-foreground">
            Orçamentos sem resposta voltam {data.days} {data.days === 1 ? 'dia' : 'dias'} depois do último contato, ou no dia combinado.
          </p>
        )}
      </div>

      {list.isPending ? (
        <div className="grid gap-2 p-4">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
      ) : !data?.items.length ? (
        <EmptyState
          title={scope === 'due' ? 'Nenhum orçamento para retomar hoje' : 'Nenhum retorno marcado'}
          description={
            scope === 'due'
              ? 'Quando um orçamento ficar sem resposta, ele aparece aqui para você voltar a falar com o cliente.'
              : 'Os orçamentos com retomada nos próximos dias aparecem aqui.'
          }
        />
      ) : (
        <>
          <Table>
            <THead>
              <TR>
                <TH className="pl-4">Retomar</TH>
                <TH>Cliente</TH>
                <TH>Orçamento</TH>
                <TH className="text-right">Total</TH>
                <TH>Último contato</TH>
                <TH>{isAdmin ? 'Vendedor e loja' : 'Vendedor'}</TH>
                <TH className="pr-4">
                  <span className="sr-only">Ações</span>
                </TH>
              </TR>
            </THead>
            <TBody className={cn(list.isPlaceholderData && 'opacity-60')}>
              {data.items.map((item) => (
                <TR key={item.id}>
                  <TD className="pl-4 whitespace-nowrap">
                    <p className="tabular-nums">{formatDay(item.due_on)}</p>
                    <p className={cn('text-[13px]', item.days_late > 0 ? 'font-semibold text-destructive' : 'text-muted-foreground')}>
                      {dueLabel(item.days_late)}
                    </p>
                  </TD>
                  <TD>
                    <p className="font-medium">{item.client_name}</p>
                    <p className="text-[13px] text-muted-foreground tabular-nums">{formatWhatsapp(item.client_whatsapp)}</p>
                  </TD>
                  <TD className="tabular-nums">
                    <Link to={`/pedidos/${item.id}`} className="font-semibold hover:underline">
                      {formatOrderNumber(item.id)}
                    </Link>
                    <p className="text-[13px] text-muted-foreground">
                      {item.followup_count === 0 ? 'Nenhuma retomada' : `${item.followup_count} ${item.followup_count === 1 ? 'retomada' : 'retomadas'}`}
                    </p>
                  </TD>
                  <TD className="text-right font-semibold whitespace-nowrap tabular-nums">{formatMoney(item.total_amount)}</TD>
                  <TD className="max-w-64">
                    <p className="whitespace-nowrap text-muted-foreground tabular-nums">{formatDateTime(item.last_contact_at)}</p>
                    {item.last_channel && (
                      <p className="line-clamp-2 text-[13px] text-muted-foreground">
                        <span className="font-medium text-foreground">{CHANNEL_LABEL[item.last_channel]}</span>
                        {item.last_note ? `: ${item.last_note}` : ''}
                      </p>
                    )}
                  </TD>
                  <TD className="text-muted-foreground">
                    <p>{item.user_name}</p>
                    {isAdmin && <p className="text-[13px]">{item.store_name}</p>}
                  </TD>
                  <TD className="pr-4">
                    <div className="flex justify-end gap-1">
                      <Button size="sm" onClick={() => setContacting(item)}>
                        <MessageCircleReply />
                        Retomar
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setLosing(item)}>
                        Perdido
                      </Button>
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <Pagination page={page} pageSize={PAGE_SIZE} total={data.total} onPageChange={onPageChange} />
        </>
      )}

      {contacting && (
        <FollowupDialog
          orderId={contacting.id}
          clientName={contacting.client_name}
          clientWhatsapp={contacting.client_whatsapp}
          onClose={() => setContacting(null)}
        />
      )}
      {losing && (
        <CancelOrderDialog
          order={{ id: losing.id, status: 'quote' }}
          open
          onOpenChange={(open) => !open && setLosing(null)}
          onCancelled={() => setLosing(null)}
        />
      )}
    </>
  );
}
