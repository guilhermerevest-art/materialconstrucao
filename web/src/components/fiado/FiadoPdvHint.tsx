import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import type { FiadoAccount } from '@/lib/types';
import { cn } from '@/lib/utils';
import { fiadoAccountKey } from './FiadoReceiveDialog';

/** No PDV, com a forma "Fiado": quanto o cliente deve, o disponível e se está bloqueado. */
export function FiadoPdvHint({ clientId, totalCents }: { clientId: number; totalCents: number }) {
  const account = useQuery({
    queryKey: fiadoAccountKey(clientId),
    queryFn: () => api<FiadoAccount>(`/fiado/accounts/${clientId}`),
  });
  const data = account.data;
  if (!data) return null;
  let text: string;
  let bad = false;
  if (data.client.credit_limit === null) {
    text = 'Cliente sem limite de fiado. O administrador libera em Clientes → Crédito.';
    bad = true;
  } else if (data.blocked) {
    text = `Fiado bloqueado: ${formatMoney(data.account.overdue)} vencido há ${data.account.days_late} ${data.account.days_late === 1 ? 'dia' : 'dias'}. Receba antes.`;
    bad = true;
  } else {
    const available = data.available ?? 0;
    bad = totalCents / 100 > available + 0.005;
    text = `Deve ${formatMoney(Math.max(0, data.account.balance))} · disponível ${formatMoney(available)}${bad ? ' (este pedido passa do limite)' : ''}.`;
  }
  return <p className={cn('text-[13px]', bad ? 'font-medium text-destructive' : 'text-muted-foreground')}>{text}</p>;
}
