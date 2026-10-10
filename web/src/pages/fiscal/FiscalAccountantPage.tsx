import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileArchive } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { FiscalNav } from '@/components/fiscal/FiscalNav';
import { EmptyState, PageHeader } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { Alert, Badge, Skeleton } from '@/components/ui/misc';
import { api, ApiError } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { useDocumentTitle } from '@/lib/hooks';

type Summary = {
  month: string;
  environment: 'homologacao' | 'producao';
  issued: { authorized: number; cancelled: number; other: number; authorized_amount: number };
  received: { count: number; amount: number };
  to_download: number;
  without_xml: number;
};

/** Mês passado ("2026-09"): é o que o contador fecha no começo do mês. */
function lastMonth() {
  const now = new Date();
  const date = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/** Pacote do mês para o contador: os XMLs das notas emitidas e recebidas, e o resumo. */
export function FiscalAccountantPage() {
  useDocumentTitle('Contador');
  const queryClient = useQueryClient();
  const [month, setMonth] = useState(lastMonth);
  const [progress, setProgress] = useState<string | null>(null);
  const [failures, setFailures] = useState<string[]>([]);
  const summary = useQuery({
    queryKey: ['fiscal-accountant', month],
    queryFn: () => api<Summary>(`/fiscal/accountant/summary?month=${month}`),
    enabled: /^\d{4}-\d{2}$/.test(month),
    retry: false,
  });
  const data = summary.data;
  const notConfigured = summary.error instanceof ApiError && summary.error.code === 'FISCAL_NOT_CONFIGURED';

  /** Baixa da ACBr API, em lotes, os XMLs que ainda não estão guardados; depois baixa o ZIP. */
  async function download() {
    setFailures([]);
    try {
      let remaining = data?.to_download ?? 0;
      const total = remaining;
      for (let round = 0; remaining > 0 && round < 100; round++) {
        setProgress(`Buscando os XMLs na ACBr API: ${total - remaining} de ${total}...`);
        try {
          const result = await api<Summary & { saved: number; failures: string[] }>('/fiscal/accountant/prepare', {
            method: 'POST',
            body: { month },
          });
          if (result.failures.length) setFailures((f) => [...f, ...result.failures]);
          // Lote sem nenhum XML novo: o que sobrou não vem (a lista de falhas diz por quê).
          if (!result.saved) break;
          remaining = result.to_download;
        } catch (err) {
          // Sem a ACBr API, o pacote sai com o que já está guardado; o resumo lista o que faltou.
          setFailures((f) => [...f, err instanceof ApiError ? err.message : 'A ACBr API não respondeu.']);
          break;
        }
      }
      setProgress('Montando o pacote...');
      const link = document.createElement('a');
      link.href = `/api/fiscal/accountant/package?month=${month}`;
      link.download = '';
      link.click();
      toast.success('Pacote do contador baixado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Não foi possível montar o pacote.');
    } finally {
      setProgress(null);
      queryClient.invalidateQueries({ queryKey: ['fiscal-accountant', month] });
    }
  }

  const [year, monthNumber] = month.split('-');
  return (
    <div>
      <PageHeader title="Fiscal" description="O pacote do mês para o escritório de contabilidade." />
      <FiscalNav />
      {notConfigured ? (
        <Card>
          <EmptyState
            title="Configure a empresa primeiro"
            description="O pacote junta as notas emitidas e recebidas pelo CNPJ cadastrado em Configurações → Fiscal."
            action={
              <Button asChild>
                <Link to="/configuracoes?aba=fiscal">Abrir Configurações → Fiscal</Link>
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:max-w-3xl">
          <Card>
            <CardHeader className="items-start">
              <div className="grid gap-1">
                <CardTitle>Pacote do contador</CardTitle>
                <CardDescription>
                  Um ZIP com os XMLs das notas emitidas (autorizadas e canceladas) e recebidas no mês, mais o resumo em planilha. É o
                  que o escritório importa para a escrituração e o SPED.
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent className="grid gap-4">
              <div className="flex flex-wrap items-end gap-3">
                <Field label="Mês" htmlFor="contador-mes" className="w-full sm:w-48">
                  <Input id="contador-mes" type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
                </Field>
                <Button onClick={download} loading={progress !== null} disabled={!data}>
                  {progress === null && <FileArchive />}
                  Baixar o pacote de {monthNumber}/{year}
                </Button>
              </div>
              {progress && <p className="text-sm text-muted-foreground">{progress}</p>}
              {summary.isError && !notConfigured && <Alert variant="danger" title={summary.error.message} />}
              {summary.isPending ? (
                <Skeleton className="h-24" />
              ) : (
                data && (
                  <>
                    {data.environment === 'homologacao' && (
                      <Alert title="Ambiente de homologação">
                        <p>As notas são de teste, sem valor fiscal. O pacote serve para conferir o formato com o contador.</p>
                      </Alert>
                    )}
                    <dl className="grid gap-3 sm:grid-cols-2">
                      <div className="rounded-md border border-border px-4 py-3">
                        <dt className="text-sm text-muted-foreground">Emitidas</dt>
                        <dd className="text-lg font-semibold tabular-nums">
                          {data.issued.authorized} autorizadas · {formatMoney(data.issued.authorized_amount)}
                        </dd>
                        <dd className="text-[13px] text-muted-foreground">
                          {data.issued.cancelled} canceladas
                          {data.issued.other > 0 && ` · ${data.issued.other} denegadas ou inutilizadas`}
                        </dd>
                      </div>
                      <div className="rounded-md border border-border px-4 py-3">
                        <dt className="text-sm text-muted-foreground">Recebidas</dt>
                        <dd className="text-lg font-semibold tabular-nums">
                          {data.received.count} notas · {formatMoney(data.received.amount)}
                        </dd>
                        <dd className="text-[13px] text-muted-foreground">Entradas no estoque do mês e notas do monitor emitidas no mês</dd>
                      </div>
                    </dl>
                    <p className="flex flex-wrap items-center gap-2 text-sm">
                      {data.to_download > 0 ? (
                        <Badge variant="quote">
                          {data.to_download} {data.to_download === 1 ? 'XML ainda na ACBr API' : 'XMLs ainda na ACBr API'}
                        </Badge>
                      ) : (
                        <Badge variant="success">XMLs guardados</Badge>
                      )}
                      {data.without_xml > 0 && (
                        <span className="text-muted-foreground">
                          {data.without_xml} {data.without_xml === 1 ? 'entrada lançada' : 'entradas lançadas'} à mão sem o XML (aparecem só no
                          resumo)
                        </span>
                      )}
                    </p>
                  </>
                )
              )}
              {failures.length > 0 && (
                <Alert variant="danger" title="Alguns XMLs não vieram da ACBr API (o pacote saiu sem eles)">
                  <ul className="list-disc pl-4 text-[13px]">
                    {failures.slice(0, 5).map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                </Alert>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
