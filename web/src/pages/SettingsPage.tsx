import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, PlugZap, TriangleAlert } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { PageHeader, WhatsAppIcon } from '@/components/shared';
import { FinanceSettingsCard } from '@/components/FinanceSettingsCard';
import { FollowupSettingsCard } from '@/components/FollowupSettingsCard';
import { WhatsAppConnection } from '@/components/WhatsAppConnection';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { Alert, Skeleton } from '@/components/ui/misc';
import { api, ApiError } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useDocumentTitle } from '@/lib/hooks';
import type { Settings } from '@/lib/types';

const STATE_MESSAGES: Record<string, { ok: boolean; text: string }> = {
  open: { ok: true, text: 'Conectado. O WhatsApp da instância está pronto para enviar.' },
  connecting: { ok: false, text: 'A instância está conectando. Tente de novo em alguns segundos.' },
  close: { ok: false, text: 'A instância está desconectada. Leia o QR Code no painel da EvolutionAPI.' },
};

export function SettingsPage() {
  useDocumentTitle('Configurações');
  const queryClient = useQueryClient();
  const [url, setUrl] = useState('');
  const [instance, setInstance] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: () => api<{ settings: Settings }>('/settings').then((r) => r.settings),
  });

  useEffect(() => {
    if (!settings.data) return;
    setUrl(settings.data.evolution_api_url ?? '');
    setInstance(settings.data.evolution_instance ?? '');
  }, [settings.data]);

  const save = useMutation({
    mutationFn: () =>
      api<{ settings: Settings }>('/settings', {
        method: 'PUT',
        body: { evolution_api_url: url, evolution_instance: instance, evolution_api_token: token },
      }),
    onSuccess: ({ settings: saved }) => {
      queryClient.setQueryData(['settings'], saved);
      setToken('');
      setTestResult(null);
      toast.success('Configurações salvas.');
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Não foi possível salvar.'),
  });

  const test = useMutation({
    mutationFn: () => api<{ state: string }>('/settings/test', { method: 'POST' }),
    onMutate: () => setTestResult(null),
    onSuccess: ({ state }) =>
      setTestResult(STATE_MESSAGES[state] ?? { ok: false, text: `A EvolutionAPI respondeu com o estado "${state}".` }),
    onError: (err) => setTestResult({ ok: false, text: err instanceof ApiError ? err.message : 'Falha no teste.' }),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    save.mutate();
  }

  const data = settings.data;

  const manualForm = (
    <form onSubmit={submit} className="grid gap-4">
      {error && <Alert variant="danger" title={error} />}
      <Field label="URL da EvolutionAPI" htmlFor="evo-url" hint="Endereço do servidor, sem o caminho da mensagem.">
        <Input
          id="evo-url"
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://evolution.suaempresa.com.br"
          required
        />
      </Field>
      <Field label="Nome da instância" htmlFor="evo-instancia" hint="Como aparece no painel da EvolutionAPI.">
        <Input
          id="evo-instancia"
          value={instance}
          onChange={(e) => setInstance(e.target.value)}
          placeholder="loja-centro"
          required
        />
      </Field>
      <Field
        label="API Key"
        htmlFor="evo-token"
        hint={
          data?.has_token
            ? `Chave salva (${data.token_hint}). Preencha só para trocar.`
            : 'Global API Key ou a chave da instância.'
        }
      >
        <Input
          id="evo-token"
          type="password"
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          required={!data?.has_token}
        />
      </Field>

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button type="submit" loading={save.isPending}>
          Salvar configurações
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => test.mutate()}
          loading={test.isPending}
          disabled={!data?.has_token}
        >
          {!test.isPending && <PlugZap />}
          Testar conexão
        </Button>
        {data?.has_token && data.updated_at && (
          <span className="text-[13px] text-muted-foreground">Atualizado em {formatDateTime(data.updated_at)}</span>
        )}
      </div>

      {testResult && (
        <Alert
          variant={testResult.ok ? 'success' : 'danger'}
          icon={testResult.ok ? <CheckCircle2 /> : <TriangleAlert />}
          title={testResult.ok ? 'Conexão funcionando' : 'A conexão não está pronta'}
        >
          <p>{testResult.text}</p>
        </Alert>
      )}
    </form>
  );

  return (
    <div className="max-w-3xl">
      <PageHeader title="Configurações" />

      <Card>
        <CardHeader className="items-start">
          <div className="flex items-start gap-3">
            <span className="grid size-10 place-items-center rounded-md bg-whatsapp text-white">
              <WhatsAppIcon className="size-5" />
            </span>
            <div>
              <CardTitle>Envio por WhatsApp</CardTitle>
              <CardDescription>
                {data?.auto_connect_available
                  ? 'Conecte o WhatsApp da loja para mandar o PDF do pedido ao cliente. Os vendedores não veem estes dados.'
                  : 'Credenciais usadas para mandar o PDF do pedido ao cliente. Os vendedores não veem estes dados.'}
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {settings.isPending ? (
            <div className="grid gap-3">
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
            </div>
          ) : (
            <div className="grid gap-5">
              {data?.auto_connect_available && <WhatsAppConnection settings={data} />}
              {data?.auto_connect_available ? (
                <details className="rounded-lg border border-border" open={!data.managed && data.has_token}>
                  <summary className="cursor-pointer px-4 py-3 text-sm font-medium select-none">
                    Usar um servidor próprio da EvolutionAPI (avançado)
                  </summary>
                  <div className="border-t border-border p-4">{manualForm}</div>
                </details>
              ) : (
                manualForm
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <FollowupSettingsCard />
      <FinanceSettingsCard />
    </div>
  );
}
