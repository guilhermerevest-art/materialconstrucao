import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Building2,
  CheckCircle2,
  PlugZap,
  FileKey2,
  Inbox,
  KeyRound,
  Activity,
  Receipt,
  Search,
  Trash2,
  TriangleAlert,
  Upload,
} from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, NativeSelect, Textarea } from '@/components/ui/input';
import { Alert, Badge, Skeleton } from '@/components/ui/misc';
import { api, ApiError } from '@/lib/api';
import { addressToForm, formatDocument, rateToInput, rateToJson, TAX_REGIMES, type AddressForm } from '@/lib/fiscal';
import { formatDate, formatDateTime } from '@/lib/format';
import type { FiscalAddress, FiscalSettings } from '@/lib/types';
import { AddressFields, mergeAddress } from './AddressFields';

type CompanyForm = {
  environment: 'homologacao' | 'producao';
  acbr_client_id: string;
  acbr_client_secret: string;
  cnpj: string;
  legal_name: string;
  trade_name: string;
  state_registration: string;
  municipal_registration: string;
  cnae: string;
  tax_regime: string;
  email: string;
  phone: string;
  operation_nature: string;
  additional_info: string;
  nfe_series: string;
  nfe_next_number: string;
  nfce_series: string;
  nfce_next_number: string;
  nfce_csc_id: string;
  nfce_csc: string;
  ibs_uf_rate: string;
  ibs_mun_rate: string;
  cbs_rate: string;
  inbound_auto_distribution: boolean;
  inbound_auto_acknowledge: boolean;
};

function toForm(s: FiscalSettings): CompanyForm {
  return {
    environment: s.environment,
    acbr_client_id: s.acbr_client_id ?? '',
    acbr_client_secret: '',
    cnpj: formatDocument(s.cnpj),
    legal_name: s.legal_name ?? '',
    trade_name: s.trade_name ?? '',
    state_registration: s.state_registration ?? '',
    municipal_registration: s.municipal_registration ?? '',
    cnae: s.cnae ?? '',
    tax_regime: s.tax_regime ? String(s.tax_regime) : '',
    email: s.email ?? '',
    phone: s.phone ?? '',
    operation_nature: s.operation_nature,
    additional_info: s.additional_info ?? '',
    nfe_series: String(s.nfe_series),
    nfe_next_number: String(s.nfe_next_number),
    nfce_series: String(s.nfce_series),
    nfce_next_number: String(s.nfce_next_number),
    nfce_csc_id: s.nfce_csc_id ?? '',
    nfce_csc: '',
    ibs_uf_rate: rateToInput(s.ibs_uf_rate),
    ibs_mun_rate: rateToInput(s.ibs_mun_rate),
    cbs_rate: rateToInput(s.cbs_rate),
    inbound_auto_distribution: s.inbound_auto_distribution,
    inbound_auto_acknowledge: s.inbound_auto_acknowledge,
  };
}

type CnpjLookup = { legal_name: string | null; trade_name: string | null; email: string | null; phone: string | null } & Partial<FiscalAddress>;

type SyncResult = { ok: true } | { ok: false; message: string } | null;

function errorMessage(err: unknown, fallback: string) {
  return err instanceof ApiError ? err.message : fallback;
}

/** Lê o arquivo .pfx como base64 (sem o prefixo "data:"). */
function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(new Error('Não foi possível ler o arquivo.'));
    reader.readAsDataURL(file);
  });
}

function Section({ icon, title, description, children }: { icon: ReactNode; title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <Card>
      <CardHeader className="items-start">
        <div className="flex items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-md bg-steel text-white [&_svg]:size-5">{icon}</span>
          <div>
            <CardTitle>{title}</CardTitle>
            {description && <CardDescription>{description}</CardDescription>}
          </div>
        </div>
      </CardHeader>
      <CardContent className="grid gap-4">{children}</CardContent>
    </Card>
  );
}

/** Certificado A1: vai direto para a ACBr API; aqui fica só quem é e até quando vale. */
function CertificateCard({ settings }: { settings: FiscalSettings }) {
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);

  const upload = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error('Escolha o arquivo do certificado.');
      const certificate = await readFileAsBase64(file);
      return api<{ settings: FiscalSettings }>('/fiscal/settings/certificate', {
        method: 'PUT',
        body: { certificate, password },
      });
    },
    onSuccess: ({ settings: saved }) => {
      queryClient.setQueryData(['fiscal-settings'], saved);
      setFile(null);
      setPassword('');
      if (fileRef.current) fileRef.current.value = '';
      toast.success('Certificado enviado para a ACBr API.');
    },
    onError: (err) => toast.error(errorMessage(err, err instanceof Error ? err.message : 'Não foi possível enviar.')),
  });

  const remove = useMutation({
    mutationFn: () => api<{ settings: FiscalSettings }>('/fiscal/settings/certificate', { method: 'DELETE' }),
    onSuccess: ({ settings: saved }) => {
      queryClient.setQueryData(['fiscal-settings'], saved);
      setConfirmRemove(false);
      toast.success('Certificado removido.');
    },
    onError: (err) => {
      setConfirmRemove(false);
      toast.error(errorMessage(err, 'Não foi possível remover.'));
    },
  });

  const validUntil = settings.certificate_valid_until ? new Date(settings.certificate_valid_until) : null;
  const daysLeft = validUntil ? Math.floor((validUntil.getTime() - Date.now()) / 86_400_000) : null;
  const canUpload = Boolean(settings.company_synced_at);

  return (
    <Section
      icon={<FileKey2 />}
      title="Certificado digital A1"
      description="Arquivo .pfx ou .p12 da empresa. Ele assina as notas na ACBr API; o arquivo e a senha não ficam guardados aqui."
    >
      {validUntil ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-4 py-3">
          <div className="grid gap-0.5 text-sm">
            <span className="font-medium">{settings.certificate_subject ?? 'Certificado enviado'}</span>
            <span className="text-muted-foreground">
              Válido até {formatDate(settings.certificate_valid_until!)}
              {settings.certificate_uploaded_at && <> · enviado em {formatDateTime(settings.certificate_uploaded_at)}</>}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {daysLeft !== null && daysLeft < 0 ? (
              <Badge variant="danger">Vencido</Badge>
            ) : daysLeft !== null && daysLeft <= 30 ? (
              <Badge variant="quote">Vence em {daysLeft} dias</Badge>
            ) : (
              <Badge variant="success">Válido</Badge>
            )}
            <Button type="button" variant="destructive-ghost" size="sm" onClick={() => setConfirmRemove(true)}>
              <Trash2 />
              Remover
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Nenhum certificado enviado. Sem ele não é possível emitir notas.</p>
      )}

      {!canUpload && (
        <Alert title="Salve os dados da empresa primeiro" className="py-3">
          <p className="text-[13px] text-muted-foreground">O certificado é vinculado à empresa cadastrada na ACBr API.</p>
        </Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-[1fr_14rem_auto] sm:items-end">
        <Field label={validUntil ? 'Trocar certificado' : 'Arquivo do certificado'} htmlFor="cert-arquivo">
          <Input
            id="cert-arquivo"
            ref={fileRef}
            type="file"
            accept=".pfx,.p12,application/x-pkcs12"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            disabled={!canUpload}
            className="py-2 file:mr-3 file:rounded file:border-0 file:bg-muted file:px-2 file:py-1 file:text-sm file:font-medium"
          />
        </Field>
        <Field label="Senha do certificado" htmlFor="cert-senha">
          <Input
            id="cert-senha"
            type="password"
            autoComplete="off"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={!canUpload}
          />
        </Field>
        <Button
          type="button"
          onClick={() => upload.mutate()}
          loading={upload.isPending}
          disabled={!canUpload || !file || !password}
        >
          {!upload.isPending && <Upload />}
          Enviar certificado
        </Button>
      </div>

      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title="Remover o certificado?"
        description="A emissão de notas para até um novo certificado ser enviado."
        confirmLabel="Remover certificado"
        destructive
        loading={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </Section>
  );
}

/** Configurações → Fiscal: dados da empresa emitente para NF-e e NFC-e. */
export function FiscalSettingsForm() {
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: ['fiscal-settings'],
    queryFn: () => api<{ settings: FiscalSettings }>('/fiscal/settings').then((r) => r.settings),
  });
  const [form, setForm] = useState<CompanyForm | null>(null);
  const [address, setAddress] = useState<AddressForm>(() => addressToForm(null));
  const [error, setError] = useState<string | null>(null);
  const [sync, setSync] = useState<SyncResult>(null);
  const [sefaz, setSefaz] = useState<{ ok: boolean; text: string } | null>(null);

  // Carrega o formulário uma vez: salvar não deve apagar o que está sendo digitado.
  useEffect(() => {
    if (!settings.data || form) return;
    setForm(toForm(settings.data));
    setAddress(addressToForm(settings.data));
  }, [settings.data, form]);

  const set = <K extends keyof CompanyForm>(key: K) => (event: { target: { value: string } }) =>
    setForm((current) => (current ? { ...current, [key]: event.target.value } : current));
  const setFlag = (key: 'inbound_auto_distribution' | 'inbound_auto_acknowledge', value: boolean) =>
    setForm((current) => (current ? { ...current, [key]: value } : current));

  const cnpjDigits = form?.cnpj.replace(/[\s./-]/g, '').toUpperCase() ?? '';

  const cnpjLookup = useMutation({
    mutationFn: () => api<{ company: CnpjLookup }>(`/fiscal/lookup/cnpj/${cnpjDigits}`),
    onSuccess: ({ company }) => {
      setForm((current) =>
        current
          ? {
              ...current,
              legal_name: company.legal_name ?? current.legal_name,
              trade_name: company.trade_name ?? current.trade_name,
              email: current.email || (company.email ?? ''),
              phone: current.phone || (company.phone ?? ''),
            }
          : current,
      );
      setAddress((current) => mergeAddress(current, company));
      toast.success('Dados da Receita Federal preenchidos. Confira a inscrição estadual e o regime.');
    },
    onError: (err) => toast.error(errorMessage(err, 'Não foi possível consultar o CNPJ.')),
  });

  const save = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      const saved = await api<{ settings: FiscalSettings }>('/fiscal/settings', { method: 'PUT', body });
      queryClient.setQueryData(['fiscal-settings'], saved.settings);
      if (!saved.settings.acbr_configured) return { settings: saved.settings, sync: null };
      // Logo depois de salvar, manda o cadastro para a ACBr API.
      try {
        const synced = await api<{ settings: FiscalSettings }>('/fiscal/settings/sync', { method: 'POST' });
        return { settings: synced.settings, sync: { ok: true } as const };
      } catch (err) {
        return { settings: saved.settings, sync: { ok: false, message: errorMessage(err, 'Falha ao enviar.') } as const };
      }
    },
    onSuccess: ({ settings: saved, sync: result }) => {
      queryClient.setQueryData(['fiscal-settings'], saved);
      setForm((current) => (current ? { ...current, acbr_client_secret: '', nfce_csc: '' } : current));
      setSync(result);
      toast.success(result?.ok ? 'Dados salvos e enviados para a ACBr API.' : 'Dados fiscais salvos.');
    },
    onError: (err) => setError(errorMessage(err, 'Não foi possível salvar.')),
  });

  const testAccount = useMutation({
    mutationFn: () =>
      api<{ ok: true }>('/fiscal/settings/test-credentials', {
        method: 'POST',
        body: { acbr_client_id: form?.acbr_client_id ?? '', acbr_client_secret: form?.acbr_client_secret ?? '' },
      }),
    onSuccess: () => toast.success('Conta da ACBr API conferida: as credenciais estão certas.'),
    onError: (err) => toast.error(errorMessage(err, 'Não foi possível conferir a conta.')),
  });

  const sefazStatus = useMutation({
    mutationFn: () =>
      api<{ status: { online: boolean; code: number | null; message: string | null; average_seconds: number | null } }>(
        '/fiscal/settings/sefaz-status',
      ),
    onMutate: () => setSefaz(null),
    onSuccess: ({ status }) =>
      setSefaz({
        ok: status.online,
        text: `${status.code ?? ''} ${status.message ?? ''}`.trim() +
          (status.average_seconds != null ? ` · tempo médio ${status.average_seconds}s` : ''),
      }),
    onError: (err) => setSefaz({ ok: false, text: errorMessage(err, 'Falha na consulta.') }),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!form) return;
    const numbers = ['nfe_series', 'nfe_next_number', 'nfce_series', 'nfce_next_number'] as const;
    for (const key of numbers) {
      if (!/^\d+$/.test(form[key].trim())) return setError('Série e próximo número são números inteiros.');
    }
    const rates = { ibs_uf_rate: rateToJson(form.ibs_uf_rate), ibs_mun_rate: rateToJson(form.ibs_mun_rate), cbs_rate: rateToJson(form.cbs_rate) };
    if (Object.values(rates).some((v) => v === null || Number.isNaN(v))) return setError('Alíquotas de IBS/CBS inválidas. Exemplo: 0,9');
    setError(null);
    save.mutate({
      ...form,
      ...address,
      tax_regime: form.tax_regime ? Number(form.tax_regime) : null,
      nfe_series: Number(form.nfe_series),
      nfe_next_number: Number(form.nfe_next_number),
      nfce_series: Number(form.nfce_series),
      nfce_next_number: Number(form.nfce_next_number),
      ...rates,
    });
  }

  const data = settings.data;
  if (settings.isPending || !form || !data) {
    if (settings.isError) return <Alert variant="danger" title={errorMessage(settings.error, 'Não foi possível carregar.')} />;
    return (
      <div className="grid gap-3">
        <Skeleton className="h-40" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  const accountChanged = Boolean(data.acbr_client_id) && form.acbr_client_id.trim() !== data.acbr_client_id;

  return (
    <div className="grid gap-6">
      <form onSubmit={submit} className="grid gap-6">
        {error && <Alert variant="danger" icon={<TriangleAlert />} title={error} />}

        <Section
          icon={<KeyRound />}
          title="Conta da loja na ACBr API"
          description="Cada lojamestre tem a sua conta na ACBr API, com as próprias empresas, notas e créditos. O client_id e o client_secret ficam no painel da ACBr API."
        >
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">Situação:</span>
            {data.acbr_configured ? (
              <Badge variant="success">Conta informada</Badge>
            ) : (
              <Badge variant="quote">Sem conta: a emissão fica bloqueada</Badge>
            )}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Client ID" htmlFor="acbr-client-id">
              <Input id="acbr-client-id" value={form.acbr_client_id} onChange={set('acbr_client_id')} autoComplete="off" />
            </Field>
            <Field
              label="Client Secret"
              htmlFor="acbr-client-secret"
              hint={
                data.acbr_client_secret_hint && !accountChanged
                  ? `Salvo (${data.acbr_client_secret_hint}). Preencha só para trocar.`
                  : 'Não volta para a tela depois de salvo.'
              }
            >
              <Input
                id="acbr-client-secret"
                type="password"
                autoComplete="off"
                value={form.acbr_client_secret}
                onChange={set('acbr_client_secret')}
              />
            </Field>
          </div>
          {accountChanged && (
            <Alert variant="danger" icon={<TriangleAlert />} title="Trocando de conta">
              <p>
                Informe o client_secret da nova conta. Depois de salvar, a empresa vai para a conta nova e o certificado
                precisa ser enviado de novo.
              </p>
            </Alert>
          )}
          <div>
            <Button
              type="button"
              variant="outline"
              onClick={() => testAccount.mutate()}
              loading={testAccount.isPending}
              disabled={!form.acbr_client_id.trim() || (!form.acbr_client_secret && (!data.acbr_client_secret_hint || accountChanged))}
            >
              {!testAccount.isPending && <PlugZap />}
              Testar conta
            </Button>
          </div>
        </Section>

        <Section icon={<Building2 />} title="Dados da empresa" description="Saem como emitente em todas as notas.">
          <div className="grid gap-4 sm:grid-cols-[16rem_1fr]">
            <Field label="CNPJ" htmlFor="empresa-cnpj">
              <div className="flex gap-2">
                <Input
                  id="empresa-cnpj"
                  value={form.cnpj}
                  onChange={set('cnpj')}
                  placeholder="00.000.000/0000-00"
                  className="tabular-nums uppercase"
                  autoComplete="off"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="size-10"
                  onClick={() => cnpjLookup.mutate()}
                  loading={cnpjLookup.isPending}
                  disabled={cnpjDigits.length !== 14 || !data.acbr_configured}
                  aria-label="Buscar dados do CNPJ"
                  title={data.acbr_configured ? 'Preencher com os dados da Receita Federal' : 'Configure a conta da ACBr API'}
                >
                  {!cnpjLookup.isPending && <Search />}
                </Button>
              </div>
            </Field>
            <Field label="Razão social" htmlFor="empresa-razao">
              <Input id="empresa-razao" value={form.legal_name} onChange={set('legal_name')} maxLength={60} />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Nome fantasia" htmlFor="empresa-fantasia">
              <Input id="empresa-fantasia" value={form.trade_name} onChange={set('trade_name')} maxLength={60} />
            </Field>
            <Field label="Regime tributário (CRT)" htmlFor="empresa-crt">
              <NativeSelect id="empresa-crt" value={form.tax_regime} onChange={set('tax_regime')}>
                <option value="">Selecione</option>
                {TAX_REGIMES.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Inscrição estadual" htmlFor="empresa-ie" hint="Só números">
              <Input id="empresa-ie" value={form.state_registration} onChange={set('state_registration')} inputMode="numeric" />
            </Field>
            <Field label="Inscrição municipal" htmlFor="empresa-im" hint="Opcional">
              <Input id="empresa-im" value={form.municipal_registration} onChange={set('municipal_registration')} />
            </Field>
            <Field label="CNAE principal" htmlFor="empresa-cnae" hint="Opcional, 7 dígitos">
              <Input id="empresa-cnae" value={form.cnae} onChange={set('cnae')} inputMode="numeric" />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="E-mail" htmlFor="empresa-email" hint="Exigido no cadastro da ACBr API">
              <Input id="empresa-email" type="email" value={form.email} onChange={set('email')} />
            </Field>
            <Field label="Telefone" htmlFor="empresa-telefone">
              <Input id="empresa-telefone" value={form.phone} onChange={set('phone')} inputMode="tel" />
            </Field>
          </div>
          <AddressFields idPrefix="empresa" value={address} onChange={setAddress} />
        </Section>

        <Section
          icon={<Receipt />}
          title="Emissão de NF-e e NFC-e"
          description="Comece em homologação para testar: as notas não têm valor fiscal."
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Ambiente da SEFAZ" htmlFor="emissao-ambiente">
              <NativeSelect id="emissao-ambiente" value={form.environment} onChange={set('environment')}>
                <option value="homologacao">Homologação (testes, sem valor fiscal)</option>
                <option value="producao">Produção</option>
              </NativeSelect>
            </Field>
            <Field label="Natureza da operação" htmlFor="emissao-natop">
              <Input id="emissao-natop" value={form.operation_nature} onChange={set('operation_nature')} maxLength={60} />
            </Field>
          </div>
          {form.environment === 'producao' && data.environment !== 'producao' && (
            <Alert variant="danger" icon={<TriangleAlert />} title="Notas em produção têm valor fiscal.">
              <p>Confira a numeração: o próximo número precisa continuar a sequência que a empresa já usa.</p>
            </Alert>
          )}
          <div className="grid gap-4 sm:grid-cols-4">
            <Field label="Série NF-e" htmlFor="emissao-nfe-serie">
              <Input id="emissao-nfe-serie" value={form.nfe_series} onChange={set('nfe_series')} inputMode="numeric" />
            </Field>
            <Field label="Próxima NF-e" htmlFor="emissao-nfe-numero">
              <Input id="emissao-nfe-numero" value={form.nfe_next_number} onChange={set('nfe_next_number')} inputMode="numeric" />
            </Field>
            <Field label="Série NFC-e" htmlFor="emissao-nfce-serie">
              <Input id="emissao-nfce-serie" value={form.nfce_series} onChange={set('nfce_series')} inputMode="numeric" />
            </Field>
            <Field label="Próxima NFC-e" htmlFor="emissao-nfce-numero">
              <Input
                id="emissao-nfce-numero"
                value={form.nfce_next_number}
                onChange={set('nfce_next_number')}
                inputMode="numeric"
              />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
            <Field label="ID do CSC (NFC-e)" htmlFor="emissao-csc-id" hint="Ex.: 1 ou 000001">
              <Input id="emissao-csc-id" value={form.nfce_csc_id} onChange={set('nfce_csc_id')} inputMode="numeric" />
            </Field>
            <Field
              label="Código CSC (NFC-e)"
              htmlFor="emissao-csc"
              hint={
                data.has_nfce_csc
                  ? `Salvo (${data.nfce_csc_hint}). Preencha só para trocar.`
                  : 'Gerado no site da SEFAZ da UF. Necessário para o QR Code da NFC-e.'
              }
            >
              <Input id="emissao-csc" type="password" autoComplete="off" value={form.nfce_csc} onChange={set('nfce_csc')} />
            </Field>
          </div>
          <Field
            label="Informações complementares padrão"
            htmlFor="emissao-infcpl"
            hint="Saem em todas as notas. Ex.: Documento emitido por ME ou EPP optante pelo Simples Nacional."
          >
            <Textarea id="emissao-infcpl" value={form.additional_info} onChange={set('additional_info')} maxLength={2000} />
          </Field>
          {form.tax_regime === '3' && (
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="IBS estadual (%)" htmlFor="emissao-ibs-uf" hint="2026: 0,1">
                <Input id="emissao-ibs-uf" value={form.ibs_uf_rate} onChange={set('ibs_uf_rate')} inputMode="decimal" />
              </Field>
              <Field label="IBS municipal (%)" htmlFor="emissao-ibs-mun" hint="2026: 0">
                <Input id="emissao-ibs-mun" value={form.ibs_mun_rate} onChange={set('ibs_mun_rate')} inputMode="decimal" />
              </Field>
              <Field label="CBS (%)" htmlFor="emissao-cbs" hint="2026: 0,9">
                <Input id="emissao-cbs" value={form.cbs_rate} onChange={set('cbs_rate')} inputMode="decimal" />
              </Field>
            </div>
          )}
        </Section>

        <Section
          icon={<Inbox />}
          title="Monitor de notas recebidas"
          description="NF-e de fornecedores emitidas contra o CNPJ da empresa, consultadas na SEFAZ pela ACBr API."
        >
          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              className="mt-0.5"
              checked={form.inbound_auto_distribution}
              onChange={(e) => setFlag('inbound_auto_distribution', e.target.checked)}
            />
            <span>
              Consultar a SEFAZ automaticamente
              <span className="block text-[13px] text-muted-foreground">A ACBr API busca notas novas a cada poucas horas.</span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              className="mt-0.5"
              checked={form.inbound_auto_acknowledge}
              onChange={(e) => setFlag('inbound_auto_acknowledge', e.target.checked)}
            />
            <span>
              Dar ciência da operação automaticamente
              <span className="block text-[13px] text-muted-foreground">
                Libera o XML completo das notas sem precisar manifestar uma a uma.
              </span>
            </span>
          </label>
        </Section>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" loading={save.isPending}>
            Salvar dados fiscais
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => sefazStatus.mutate()}
            loading={sefazStatus.isPending}
            disabled={!data.company_synced_at}
          >
            {!sefazStatus.isPending && <Activity />}
            Consultar SEFAZ
          </Button>
          {data.company_synced_at && (
            <span className="text-[13px] text-muted-foreground">
              Enviado para a ACBr API em {formatDateTime(data.company_synced_at)}
            </span>
          )}
        </div>

        {sync && !sync.ok && (
          <Alert variant="danger" icon={<TriangleAlert />} title="Salvo aqui, mas a ACBr API recusou o cadastro">
            <p>{sync.message}</p>
          </Alert>
        )}
        {sefaz && (
          <Alert
            variant={sefaz.ok ? 'success' : 'danger'}
            icon={sefaz.ok ? <CheckCircle2 /> : <TriangleAlert />}
            title={sefaz.ok ? 'SEFAZ em operação' : 'SEFAZ indisponível ou com problema'}
          >
            <p>{sefaz.text}</p>
          </Alert>
        )}
      </form>

      <CertificateCard settings={data} />
    </div>
  );
}
