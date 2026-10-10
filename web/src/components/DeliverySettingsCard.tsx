import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Truck } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Checkbox } from './ui/input';
import { Skeleton } from './ui/misc';

type DeliverySettings = { requires_invoice: boolean };

/** Entrega × nota fiscal: segurar o romaneio enquanto algum pedido dele não tem nota autorizada. */
export function DeliverySettingsCard() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['delivery-settings'],
    queryFn: () => api<{ settings: DeliverySettings }>('/delivery-settings').then((r) => r.settings),
  });
  const save = useMutation({
    mutationFn: (body: DeliverySettings) => api<{ settings: DeliverySettings }>('/delivery-settings', { method: 'PUT', body }),
    onSuccess: ({ settings }) => {
      queryClient.setQueryData(['delivery-settings'], settings);
      toast.success(settings.requires_invoice ? 'O romaneio só sai com as notas autorizadas.' : 'O romaneio sai sem exigir a nota.');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Não foi possível salvar.'),
  });
  return (
    <Card className="mt-6">
      <CardHeader>
        <div className="grid gap-1">
          <CardTitle className="flex items-center gap-2">
            <Truck className="size-5 text-muted-foreground" />
            Entregas
          </CardTitle>
          <CardDescription>A nota fiscal autorizada do pedido aparece na agenda, no romaneio e no comprovante.</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        {query.isPending ? (
          <Skeleton className="h-6 w-80" />
        ) : (
          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              className="mt-0.5"
              checked={Boolean(query.data?.requires_invoice)}
              disabled={save.isPending}
              onChange={(e) => save.mutate({ requires_invoice: e.target.checked })}
            />
            <span>
              <span className="font-medium">Exigir nota fiscal para o caminhão sair</span>
              <span className="block text-muted-foreground">
                "Saiu para entrega" fica bloqueado enquanto algum pedido do romaneio não tem NF-e ou NFC-e autorizada.
              </span>
            </span>
          </label>
        )}
      </CardContent>
    </Card>
  );
}
