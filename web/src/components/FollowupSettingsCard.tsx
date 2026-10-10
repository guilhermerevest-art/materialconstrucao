import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageCircleReply } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import type { FollowupSettings } from '@/lib/types';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Field, Input, Textarea } from './ui/input';
import { Alert, Skeleton } from './ui/misc';

/** Em quantos dias o orçamento sem resposta volta para a lista e a mensagem do WhatsApp. */
export function FollowupSettingsCard() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['followup-settings'],
    queryFn: () => api<{ settings: FollowupSettings }>('/followups/settings').then((r) => r.settings),
  });
  const [days, setDays] = useState('3');
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!query.data) return;
    setDays(String(query.data.followup_days));
    setMessage(query.data.followup_message ?? query.data.default_message);
  }, [query.data]);

  const save = useMutation({
    mutationFn: (body: { followup_days: number; followup_message: string | null }) =>
      api<{ settings: FollowupSettings }>('/followups/settings', { method: 'PUT', body }),
    onSuccess: ({ settings }) => {
      queryClient.setQueryData(['followup-settings'], settings);
      queryClient.invalidateQueries({ queryKey: ['followups'] });
      queryClient.invalidateQueries({ queryKey: ['order-followups'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      toast.success('Retomada salva.');
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Não foi possível salvar.'),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const value = Number(days);
    if (!Number.isInteger(value) || value < 1 || value > 60) return setError('Use de 1 a 60 dias.');
    setError(null);
    const text = message.trim();
    // Igual à padrão: guarda nulo, para acompanhar melhorias da mensagem padrão.
    save.mutate({ followup_days: value, followup_message: !text || text === query.data?.default_message ? null : text });
  }

  return (
    <Card className="mt-6">
      <CardHeader className="items-start">
        <div className="flex items-start gap-3">
          <MessageCircleReply className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
          <div className="grid gap-0.5">
            <CardTitle>Retomada de orçamentos</CardTitle>
            <CardDescription>
              Orçamento sem resposta volta para a lista "A retomar" (em Pedidos) alguns dias depois do último contato, para o vendedor
              falar de novo com o cliente.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {query.isPending ? (
          <Skeleton className="h-40" />
        ) : (
          <form onSubmit={submit} className="grid gap-4">
            {error && <Alert variant="danger" title={error} />}
            <Field label="Retomar depois de (dias)" htmlFor="retomada-dias" className="w-48">
              <Input id="retomada-dias" type="number" min={1} max={60} value={days} onChange={(e) => setDays(e.target.value)} />
            </Field>
            <Field
              label="Mensagem do WhatsApp"
              htmlFor="retomada-modelo"
              hint="Use {cliente}, {vendedor}, {loja}, {pedido} e {total}. O vendedor pode ajustar antes de enviar."
            >
              <Textarea id="retomada-modelo" rows={4} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={1000} />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" loading={save.isPending}>
                Salvar retomada
              </Button>
              {query.data && message.trim() !== query.data.default_message && (
                <Button type="button" variant="ghost" onClick={() => setMessage(query.data!.default_message)}>
                  Voltar para a mensagem padrão
                </Button>
              )}
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
