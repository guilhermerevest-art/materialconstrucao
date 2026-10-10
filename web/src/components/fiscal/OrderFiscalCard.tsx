import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Receipt, ReceiptText } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/misc';
import { api, ApiError } from '@/lib/api';
import { formatAccessKey, modelLabel } from '@/lib/fiscal';
import { formatDateTime } from '@/lib/format';
import type { FiscalDocument, FiscalModel, Order, Paginated } from '@/lib/types';
import { FiscalDocumentActions, FiscalProblems, FiscalStatusBadge } from './FiscalDocumentActions';

/** A nota em processamento é consultada de novo até sair da fila da SEFAZ. */
const PENDING_POLL_MS = 4_000;
const PENDING_POLL_LIMIT = 15;

const OPEN_STATUSES: FiscalDocument['status'][] = ['pendente', 'autorizado', 'rejeitado', 'erro'];

/** Nota fiscal do pedido: emissão da NFC-e (balcão) ou da NF-e, e a situação de cada uma. */
export function OrderFiscalCard({ order }: { order: Order }) {
  const queryClient = useQueryClient();
  const [problems, setProblems] = useState<string[] | null>(null);
  const [polls, setPolls] = useState(0);

  const documents = useQuery({
    queryKey: ['fiscal-documents', 'order', order.id],
    queryFn: () => api<Paginated<FiscalDocument>>(`/fiscal/documents?order_id=${order.id}&page_size=20`).then((r) => r.items),
    enabled: order.status === 'order',
  });

  const items = documents.data ?? [];
  const open = items.find((d) => OPEN_STATUSES.includes(d.status));
  const pending = items.find((d) => d.status === 'pendente');

  // Enquanto a SEFAZ processa, pergunta de novo a cada poucos segundos.
  useEffect(() => {
    if (!pending || polls >= PENDING_POLL_LIMIT) return;
    const timer = setTimeout(() => {
      api<{ document: FiscalDocument }>(`/fiscal/documents/${pending.id}/sync`, { method: 'POST' })
        .catch(() => null)
        .finally(() => {
          setPolls((n) => n + 1);
          void queryClient.invalidateQueries({ queryKey: ['fiscal-documents'] });
        });
    }, PENDING_POLL_MS);
    return () => clearTimeout(timer);
  }, [pending, polls, queryClient]);

  const emit = useMutation({
    mutationFn: (model: FiscalModel) =>
      api<{ document: FiscalDocument }>('/fiscal/documents', { method: 'POST', body: { order_id: order.id, model } }),
    onMutate: () => setProblems(null),
    onSuccess: ({ document }) => {
      setPolls(0);
      void queryClient.invalidateQueries({ queryKey: ['fiscal-documents'] });
      const name = `${modelLabel(document.model)} nº ${document.number}`;
      if (document.status === 'autorizado') toast.success(`${name} autorizada.`);
      else if (document.status === 'pendente') toast(`${name} enviada. Aguardando a SEFAZ...`);
      else toast.error(`${name}: ${document.status_message ?? 'não autorizada.'}`);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.problems?.length) setProblems(err.problems);
      else toast.error(err instanceof ApiError ? err.message : 'Não foi possível emitir.');
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ReceiptText className="size-4 text-muted-foreground" />
          Nota fiscal
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        {order.status !== 'order' ? (
          <p className="text-sm text-muted-foreground">Converta o orçamento em pedido para emitir a nota fiscal.</p>
        ) : documents.isPending ? (
          <Skeleton className="h-16" />
        ) : (
          <>
            {items.map((doc) => (
              <div key={doc.id} className="grid gap-2 rounded-lg border border-border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-semibold">
                    {modelLabel(doc.model)} nº {doc.number}
                    <span className="font-normal text-muted-foreground"> · série {doc.series}</span>
                  </span>
                  <FiscalStatusBadge status={doc.status} />
                </div>
                {doc.environment === 'homologacao' && (
                  <p className="text-[12px] font-medium text-quote">Homologação: sem valor fiscal</p>
                )}
                {doc.access_key && doc.status !== 'rejeitado' && (
                  <p className="font-mono text-[11px] leading-snug break-words text-muted-foreground">
                    {formatAccessKey(doc.access_key)}
                  </p>
                )}
                {doc.status_message && doc.status !== 'autorizado' && (
                  <p className="text-[13px] text-muted-foreground">
                    {doc.status_code ? `${doc.status_code} · ` : ''}
                    {doc.status_message}
                  </p>
                )}
                {doc.status === 'autorizado' && doc.authorized_at && (
                  <p className="text-[13px] text-muted-foreground">Autorizada em {formatDateTime(doc.authorized_at)}</p>
                )}
                <FiscalDocumentActions document={doc} />
              </div>
            ))}

            {!open && (
              <div className="grid gap-2">
                <Button
                  variant="steel"
                  className="w-full"
                  onClick={() => emit.mutate(65)}
                  loading={emit.isPending && emit.variables === 65}
                  disabled={emit.isPending}
                >
                  {!(emit.isPending && emit.variables === 65) && <Receipt />}
                  Emitir NFC-e (cupom)
                </Button>
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => emit.mutate(55)}
                  loading={emit.isPending && emit.variables === 55}
                  disabled={emit.isPending}
                >
                  {!(emit.isPending && emit.variables === 55) && <ReceiptText />}
                  Emitir NF-e
                </Button>
                <p className="text-[12px] text-muted-foreground">
                  NFC-e para o consumidor no balcão; NF-e para empresa, entrega ou quando o cliente pedir (exige o cadastro
                  completo).
                </p>
              </div>
            )}
            {problems && <FiscalProblems title="A nota não pode ser emitida ainda" problems={problems} />}
          </>
        )}
      </CardContent>
    </Card>
  );
}
