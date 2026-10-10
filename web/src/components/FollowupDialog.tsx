import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { CHANNEL_LABEL } from '@/lib/followups';
import { addDays, formatDay, formatWhatsapp, todayIso } from '@/lib/format';
import type { Followup, FollowupChannel, FollowupHistory } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Checkbox, Field, Input, Textarea } from './ui/input';
import { Alert, Skeleton } from './ui/misc';

const CHANNELS: FollowupChannel[] = ['whatsapp', 'call', 'visit', 'other'];

type NextChoice = 'auto' | '1' | '7' | '15' | 'date';

/** Invalida tudo que mostra a retomada do orçamento. */
export function useInvalidateFollowups() {
  const queryClient = useQueryClient();
  return (orderId: number) => {
    queryClient.invalidateQueries({ queryKey: ['followups'] });
    queryClient.invalidateQueries({ queryKey: ['order-followups', orderId] });
    queryClient.invalidateQueries({ queryKey: ['order', orderId] });
    queryClient.invalidateQueries({ queryKey: ['orders'] });
    queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  };
}

/**
 * Registra um contato de retomada do orçamento: WhatsApp enviado daqui (com o PDF, se quiser),
 * ligação, visita ou outro, e quando voltar a falar com o cliente.
 */
export function FollowupDialog({
  orderId,
  clientName,
  clientWhatsapp,
  onClose,
}: {
  orderId: number;
  clientName: string;
  clientWhatsapp: string;
  onClose: () => void;
}) {
  const invalidate = useInvalidateFollowups();
  const history = useQuery({
    queryKey: ['order-followups', orderId],
    queryFn: () => api<FollowupHistory>(`/orders/${orderId}/followups`),
  });
  const [channel, setChannel] = useState<FollowupChannel>('whatsapp');
  const [message, setMessage] = useState('');
  const [withPdf, setWithPdf] = useState(false);
  const [note, setNote] = useState('');
  const [next, setNext] = useState<NextChoice>('auto');
  const [nextDate, setNextDate] = useState('');
  const [error, setError] = useState<string | null>(null);

  // A mensagem sugerida chega com o histórico; depois disso é do vendedor.
  const suggested = history.data?.message;
  useEffect(() => {
    if (suggested) setMessage((current) => current || suggested);
  }, [suggested]);

  const tomorrow = addDays(todayIso(), 1);
  const nextOn = next === 'auto' ? null : next === 'date' ? nextDate || null : addDays(todayIso(), Number(next));
  const days = history.data?.days ?? 3;

  const save = useMutation({
    mutationFn: () =>
      api<{ followup: Followup }>(`/orders/${orderId}/followups`, {
        method: 'POST',
        body: {
          channel,
          note: note.trim() || null,
          message: channel === 'whatsapp' ? message.trim() || null : null,
          with_pdf: channel === 'whatsapp' && withPdf,
          next_on: nextOn,
        },
      }),
    onSuccess: ({ followup }) => {
      invalidate(orderId);
      const when = followup.next_on ? formatDay(followup.next_on) : `${days} dias`;
      toast.success(
        channel === 'whatsapp'
          ? `Mensagem enviada para ${clientName}. Próxima retomada: ${when}.`
          : `Contato registrado. Próxima retomada: ${when}.`,
      );
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Não foi possível registrar.'),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (channel === 'whatsapp' && !message.trim()) return setError('Escreva a mensagem.');
    if (channel !== 'whatsapp' && note.trim().length === 0) return setError('Conte em poucas palavras como foi a conversa.');
    if (next === 'date' && !nextDate) return setError('Escolha o dia do próximo contato.');
    setError(null);
    save.mutate();
  }

  const nextOptions: { value: NextChoice; label: string }[] = [
    { value: 'auto', label: `Em ${days} dias` },
    { value: '1', label: 'Amanhã' },
    { value: '7', label: '1 semana' },
    { value: '15', label: '15 dias' },
    { value: 'date', label: 'Outra data' },
  ];

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Retomar com {clientName}</DialogTitle>
          <DialogDescription>
            {formatWhatsapp(clientWhatsapp)}
            {history.data && history.data.followup_count > 0
              ? ` · ${history.data.followup_count} ${history.data.followup_count === 1 ? 'contato' : 'contatos'} até agora`
              : ''}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          {error && <Alert variant="danger" title={error} />}
          <div className="grid gap-1.5">
            <span className="text-sm font-medium">Como foi o contato</span>
            <div className="flex flex-wrap rounded-md border border-input bg-background p-0.5" role="group" aria-label="Como foi o contato">
              {CHANNELS.map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setChannel(value)}
                  aria-pressed={channel === value}
                  className={cn(
                    'h-8 flex-1 rounded px-3 text-sm font-medium whitespace-nowrap',
                    channel === value ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {CHANNEL_LABEL[value]}
                </button>
              ))}
            </div>
          </div>

          {channel === 'whatsapp' ? (
            history.isPending ? (
              <Skeleton className="h-32" />
            ) : (
              <>
                <Field label="Mensagem" htmlFor="retomada-mensagem" hint="Sai pelo WhatsApp da loja assim que você confirmar.">
                  <Textarea id="retomada-mensagem" rows={5} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={1000} />
                </Field>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={withPdf} onChange={(e) => setWithPdf(e.target.checked)} />
                  Mandar o PDF do orçamento junto
                </label>
              </>
            )
          ) : (
            <Field label="Como foi" htmlFor="retomada-nota">
              <Textarea
                id="retomada-nota"
                rows={3}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={300}
                placeholder="Ex.: vai fechar quando o mestre de obras aprovar"
                autoFocus
              />
            </Field>
          )}

          <div className="grid gap-1.5">
            <span className="text-sm font-medium">Próximo contato</span>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Próximo contato">
              {nextOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setNext(option.value)}
                  aria-pressed={next === option.value}
                  className={cn(
                    'h-8 rounded-md border px-3 text-sm font-medium',
                    next === option.value
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-input bg-background text-muted-foreground hover:text-foreground',
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
            {next === 'date' && (
              <Input
                aria-label="Dia do próximo contato"
                type="date"
                min={tomorrow}
                value={nextDate}
                onChange={(e) => setNextDate(e.target.value)}
                className="w-full sm:w-48"
              />
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" loading={save.isPending} disabled={channel === 'whatsapp' && history.isPending}>
              {channel === 'whatsapp' ? 'Enviar e registrar' : 'Registrar contato'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
