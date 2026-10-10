import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { NotebookPen } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { ME_KEY } from '@/lib/auth';
import { decimalToInput, parseDecimal } from '@/lib/format';
import type { FiadoSettings } from '@/lib/types';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Checkbox, Field, Input, Textarea } from './ui/input';
import { Alert, Skeleton } from './ui/misc';

/** Liga o fiado (caderneta) e define vencimento, bloqueio por atraso, encargos e a mensagem de cobrança. */
export function FiadoSettingsCard() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['fiado-settings'],
    queryFn: () => api<{ settings: FiadoSettings }>('/fiado/settings').then((r) => r.settings),
  });
  const [enabled, setEnabled] = useState(false);
  const [dueDay, setDueDay] = useState('10');
  const [blockDays, setBlockDays] = useState('0');
  const [fee, setFee] = useState('0');
  const [interest, setInterest] = useState('0');
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const s = query.data;
    if (!s) return;
    setEnabled(s.enabled);
    setDueDay(String(s.due_day));
    setBlockDays(String(s.block_days));
    setFee(decimalToInput(s.late_fee_percent));
    setInterest(decimalToInput(s.interest_percent));
    setMessage(s.message ?? s.default_message);
  }, [query.data]);

  const save = useMutation({
    mutationFn: (body: object) => api<{ settings: FiadoSettings }>('/fiado/settings', { method: 'PUT', body }),
    onSuccess: ({ settings }) => {
      queryClient.setQueryData(['fiado-settings'], settings);
      queryClient.invalidateQueries({ queryKey: ME_KEY });
      queryClient.invalidateQueries({ queryKey: ['payment-methods'] });
      toast.success(settings.enabled ? 'Fiado ligado. A forma "Fiado" já está no PDV.' : 'Fiado salvo.');
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Não foi possível salvar.'),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const day = Number(dueDay);
    const block = Number(blockDays);
    const lateFee = parseDecimal(fee || '0');
    const monthly = parseDecimal(interest || '0');
    if (!Number.isInteger(day) || day < 1 || day > 28) return setError('Dia de vencimento de 1 a 28.');
    if (!Number.isInteger(block) || block < 0) return setError('Tolerância em dias, 0 ou mais.');
    if (lateFee === null || lateFee < 0 || lateFee > 20) return setError('Multa de 0 a 20%.');
    if (monthly === null || monthly < 0 || monthly > 20) return setError('Juros de 0 a 20% ao mês.');
    setError(null);
    const text = message.trim();
    save.mutate({
      enabled,
      due_day: day,
      block_days: block,
      late_fee_percent: lateFee,
      interest_percent: monthly,
      message: !text || text === query.data?.default_message ? null : text,
    });
  }

  return (
    <Card>
      <CardHeader className="items-start">
        <div className="flex items-start gap-3">
          <NotebookPen className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
          <div className="grid gap-0.5">
            <CardTitle>Fiado (caderneta)</CardTitle>
            <CardDescription>
              Opcional e independente do financeiro. Ligado, a venda na forma "Fiado" soma na conta do cliente e vence no dia de
              vencimento do mês seguinte; o pagamento abate as compras mais antigas. O limite de cada cliente fica em Clientes → Crédito.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {query.isPending ? (
          <Skeleton className="h-48" />
        ) : (
          <form onSubmit={submit} className="grid gap-4">
            {error && <Alert variant="danger" title={error} />}
            <label className="flex items-center gap-2 text-sm font-medium">
              <Checkbox checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
              Ligar o fiado
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Dia de vencimento" htmlFor="fiado-dia" hint="As compras de um mês vencem neste dia do mês seguinte. Cada cliente pode ter o seu.">
                <Input id="fiado-dia" inputMode="numeric" value={dueDay} onChange={(e) => setDueDay(e.target.value.replace(/\D/g, ''))} maxLength={2} className="w-24" />
              </Field>
              <Field label="Bloquear depois de (dias de atraso)" htmlFor="fiado-bloqueio" hint="0 = qualquer atraso bloqueia nova compra fiada.">
                <Input id="fiado-bloqueio" inputMode="numeric" value={blockDays} onChange={(e) => setBlockDays(e.target.value.replace(/\D/g, ''))} maxLength={3} className="w-24" />
              </Field>
              <Field label="Multa por atraso (%)" htmlFor="fiado-multa" hint="Cobrada uma vez sobre o valor atrasado. 0 = sem multa.">
                <Input id="fiado-multa" inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} className="w-24 text-right tabular-nums" />
              </Field>
              <Field label="Juros ao mês (%)" htmlFor="fiado-juros" hint="Proporcional aos dias de atraso. 0 = sem juros.">
                <Input id="fiado-juros" inputMode="decimal" value={interest} onChange={(e) => setInterest(e.target.value)} className="w-24 text-right tabular-nums" />
              </Field>
            </div>
            <Field
              label="Mensagem de cobrança (WhatsApp)"
              htmlFor="fiado-mensagem"
              hint="Use {cliente}, {loja}, {saldo}, {vencido} e {vencimento}. Vai com o extrato em PDF."
            >
              <Textarea id="fiado-mensagem" rows={3} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={1000} />
            </Field>
            <Button type="submit" className="justify-self-start" loading={save.isPending}>
              Salvar fiado
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
