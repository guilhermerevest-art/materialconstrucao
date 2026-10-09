import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { QrCode, RefreshCw, Unplug } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { WhatsAppIcon } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Alert, Badge, Skeleton } from '@/components/ui/misc';
import { api, ApiError } from '@/lib/api';
import type { Settings, WhatsAppQrCode } from '@/lib/types';

/** O QR Code da EvolutionAPI expira em cerca de 40 s: buscamos um novo antes disso. */
const QR_REFRESH_MS = 30_000;
const STATUS_POLL_MS = 3_000;

const STATE_LABELS: Record<string, { variant: 'success' | 'neutral' | 'danger'; text: string }> = {
  open: { variant: 'success', text: 'Conectado' },
  connecting: { variant: 'neutral', text: 'Aguardando leitura do QR Code' },
  close: { variant: 'danger', text: 'Desconectado' },
};

function errorMessage(err: unknown, fallback: string) {
  return err instanceof ApiError ? err.message : fallback;
}

/** Conexão automática: o sistema cria a instância e a loja só lê o QR Code no celular. */
export function WhatsAppConnection({ settings }: { settings: Settings }) {
  const queryClient = useQueryClient();
  const [qr, setQr] = useState<WhatsAppQrCode | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const qrOpen = qr !== null;

  const status = useQuery({
    queryKey: ['settings', 'whatsapp-status'],
    queryFn: () => api<{ state: string }>('/settings/test', { method: 'POST' }).then((r) => r.state),
    enabled: settings.has_token,
    retry: false,
    refetchInterval: qrOpen ? STATUS_POLL_MS : false,
  });

  const connected = status.data === 'open';

  function onConnected() {
    setQr(null);
    toast.success('WhatsApp conectado. Os pedidos já podem ser enviados.');
    void queryClient.invalidateQueries({ queryKey: ['settings'] });
  }

  const connect = useMutation({
    mutationFn: () => api<WhatsAppQrCode>('/settings/whatsapp/connect', { method: 'POST' }),
    onMutate: () => setQrError(null),
    onSuccess: (result) => {
      // A instância pode ter sido criada agora: atualiza URL, nome e chave salvos.
      void queryClient.invalidateQueries({ queryKey: ['settings'], exact: true });
      if (result.state === 'open') onConnected();
      else setQr(result);
    },
    onError: (err) => toast.error(errorMessage(err, 'Não foi possível gerar o QR Code.')),
  });

  // Enquanto o QR Code está na tela, troca por um novo antes de expirar.
  useEffect(() => {
    if (!qrOpen) return;
    const timer = setInterval(() => {
      api<WhatsAppQrCode>('/settings/whatsapp/connect', { method: 'POST' })
        .then((result) => {
          setQrError(null);
          if (result.state === 'open') onConnected();
          else setQr(result);
        })
        .catch((err) => setQrError(errorMessage(err, 'Não foi possível atualizar o QR Code.')));
    }, QR_REFRESH_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qrOpen]);

  useEffect(() => {
    if (qrOpen && status.data === 'open') onConnected();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qrOpen, status.data]);

  const disconnect = useMutation({
    mutationFn: () => api<{ settings: Settings }>('/settings/whatsapp/disconnect', { method: 'POST' }),
    onSuccess: ({ settings: saved }) => {
      queryClient.setQueryData(['settings'], saved);
      queryClient.removeQueries({ queryKey: ['settings', 'whatsapp-status'] });
      setConfirmDisconnect(false);
      toast.success('WhatsApp desconectado.');
    },
    onError: (err) => {
      setConfirmDisconnect(false);
      toast.error(errorMessage(err, 'Não foi possível desconectar.'));
    },
  });

  const label = status.data ? (STATE_LABELS[status.data] ?? { variant: 'neutral', text: status.data }) : null;

  return (
    <div className="grid gap-4">
      {!settings.has_token ? (
        <p className="text-sm text-muted-foreground">
          Nenhum WhatsApp conectado. Clique em <strong>Conectar WhatsApp</strong> e leia o QR Code com o celular da loja.
        </p>
      ) : (
        <div className="grid gap-2">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">Situação:</span>
            {status.isPending ? (
              <Skeleton className="h-5 w-28" />
            ) : status.isError ? (
              <Badge variant="danger">Sem resposta</Badge>
            ) : (
              label && <Badge variant={label.variant}>{label.text}</Badge>
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void status.refetch()}
              disabled={status.isFetching}
              aria-label="Atualizar situação"
            >
              <RefreshCw className={status.isFetching ? 'animate-spin' : undefined} />
            </Button>
          </div>
          {status.isError && <p className="text-sm text-destructive">{errorMessage(status.error, 'Falha ao consultar.')}</p>}
          {!settings.managed && (
            <p className="text-[13px] text-muted-foreground">
              Configurado manualmente (instância {settings.evolution_instance}). Conectar pelo QR Code troca para a conexão
              automática.
            </p>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {!connected && (
          <Button type="button" variant="whatsapp" onClick={() => connect.mutate()} loading={connect.isPending}>
            {!connect.isPending && (settings.has_token ? <QrCode /> : <WhatsAppIcon className="size-4" />)}
            {settings.has_token ? 'Gerar QR Code' : 'Conectar WhatsApp'}
          </Button>
        )}
        {settings.has_token && (
          <Button type="button" variant="destructive-ghost" onClick={() => setConfirmDisconnect(true)}>
            <Unplug />
            Desconectar
          </Button>
        )}
      </div>

      <Dialog open={qrOpen} onOpenChange={(open) => !open && setQr(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Conectar o WhatsApp da loja</DialogTitle>
            <DialogDescription>A tela fecha sozinha quando o celular conectar.</DialogDescription>
          </DialogHeader>
          <ol className="grid list-decimal gap-1 pl-5 text-sm">
            <li>Abra o WhatsApp no celular da loja.</li>
            <li>
              Toque em <strong>Mais opções</strong> (ou <strong>Configurações</strong>) e em{' '}
              <strong>Aparelhos conectados</strong>.
            </li>
            <li>
              Toque em <strong>Conectar um aparelho</strong> e aponte a câmera para o código abaixo.
            </li>
          </ol>
          <div className="grid place-items-center rounded-lg border border-border bg-white p-4">
            {qr?.qrcode ? (
              <img src={qr.qrcode} alt="QR Code para conectar o WhatsApp" className="size-64" />
            ) : (
              <Skeleton className="size-64" />
            )}
          </div>
          {qr?.pairing_code && (
            <p className="text-center text-sm text-muted-foreground">
              Ou conecte com o código <strong className="font-mono text-foreground">{qr.pairing_code}</strong>
            </p>
          )}
          {qrError && <Alert variant="danger" title={qrError} />}
          <p className="text-center text-[13px] text-muted-foreground">O código é atualizado a cada 30 segundos.</p>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        title="Desconectar o WhatsApp?"
        description="Os pedidos deixam de ser enviados pelo WhatsApp até que um novo celular seja conectado."
        confirmLabel="Desconectar"
        destructive
        loading={disconnect.isPending}
        onConfirm={() => disconnect.mutate()}
      />
    </div>
  );
}
