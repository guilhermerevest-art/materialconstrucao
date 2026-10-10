import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FileText, Search, TriangleAlert, UserRound } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { addressToForm, emptyAddress, formatDocument, IE_INDICATORS, type AddressForm } from '@/lib/fiscal';
import { formatWhatsapp } from '@/lib/format';
import type { Client, ClientDetails, FiscalAddress } from '@/lib/types';
import { AddressFields, mergeAddress } from './fiscal/AddressFields';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Checkbox, Field, Input, NativeSelect } from './ui/input';
import { Alert } from './ui/misc';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';

type DetailsForm = {
  person_type: 'F' | 'J';
  document: string;
  trade_name: string;
  state_registration: string;
  ie_indicator: string;
  final_consumer: boolean;
  email: string;
  phone: string;
};

function detailsToForm(details: ClientDetails | undefined): DetailsForm {
  return {
    person_type: details?.person_type ?? 'F',
    document: formatDocument(details?.document),
    trade_name: details?.trade_name ?? '',
    state_registration: details?.state_registration ?? '',
    ie_indicator: details?.ie_indicator ? String(details.ie_indicator) : '9',
    final_consumer: details?.final_consumer ?? true,
    email: details?.email ?? '',
    phone: details?.phone ?? '',
  };
}

type CnpjLookup = {
  legal_name: string | null;
  trade_name: string | null;
  email: string | null;
  phone: string | null;
  situation: string | null;
} & Partial<FiscalAddress>;

/** Cadastro e edição de cliente. Usado na tela de clientes e no PDV (cadastro rápido). */
export function ClientFormDialog({
  open,
  onOpenChange,
  client,
  initialValues,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  client?: Client | null;
  initialValues?: { name?: string; whatsapp?: string };
  onSaved?: (client: Client) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [whatsapp, setWhatsapp] = useState('');
  const [contactName, setContactName] = useState('');
  const [details, setDetails] = useState<DetailsForm>(() => detailsToForm(undefined));
  const [address, setAddress] = useState<AddressForm>(emptyAddress);
  const [tab, setTab] = useState('contato');
  const [error, setError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<Client[] | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(client?.name ?? initialValues?.name ?? '');
    setWhatsapp(client ? formatWhatsapp(client.whatsapp) : (initialValues?.whatsapp ?? ''));
    setContactName(client?.contact_name ?? '');
    setDetails(detailsToForm(client?.details));
    setAddress(addressToForm(client?.details));
    setTab('contato');
    setError(null);
    setConflicts(null);
    // Só ao abrir: os valores iniciais não devem sobrescrever o que está sendo digitado.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const setDetail = <K extends keyof DetailsForm>(key: K, value: DetailsForm[K]) =>
    setDetails((current) => ({ ...current, [key]: value }));

  const isCompany = details.person_type === 'J';
  const documentDigits = details.document.replace(/[\s./-]/g, '').toUpperCase();

  const cnpjLookup = useMutation({
    mutationFn: () => api<{ company: CnpjLookup }>(`/fiscal/lookup/cnpj/${documentDigits}`),
    onSuccess: ({ company }) => {
      if (company.legal_name) setName(company.legal_name);
      setDetails((current) => ({
        ...current,
        trade_name: company.trade_name ?? current.trade_name,
        email: current.email || (company.email ?? ''),
        phone: current.phone || (company.phone ?? ''),
      }));
      setAddress((current) => mergeAddress(current, company));
      toast.success(
        company.situation && company.situation.toUpperCase() !== 'ATIVA'
          ? `Dados preenchidos. Atenção: situação na Receita "${company.situation}".`
          : 'Dados da Receita Federal preenchidos. Confira antes de salvar.',
      );
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Não foi possível consultar o CNPJ.'),
  });

  const mutation = useMutation({
    mutationFn: () => {
      const ieIndicator = Number(details.ie_indicator);
      // Editando um cliente que veio sem o cadastro completo, o bloco não vai: o servidor mantém o salvo.
      const sendDetails = !client || Boolean(client.details);
      const body = {
        name,
        whatsapp,
        // Mesma regra: cliente que veio sem o campo (de outra tela) mantém o contato salvo.
        contact_name: !client || client.contact_name !== undefined ? contactName : undefined,
        details: sendDetails ? {
          person_type: details.person_type,
          document: documentDigits || null,
          trade_name: isCompany ? details.trade_name : null,
          state_registration: details.state_registration,
          ie_indicator: ieIndicator,
          final_consumer: details.final_consumer,
          email: details.email,
          phone: details.phone,
          ...address,
        } : undefined,
      };
      return client
        ? api<{ client: Client }>(`/clients/${client.id}`, { method: 'PUT', body })
        : api<{ client: Client }>('/clients', { method: 'POST', body });
    },
    onSuccess: ({ client: saved }) => {
      queryClient.invalidateQueries({ queryKey: ['clients'] });
      toast.success(client ? 'Cliente atualizado.' : `${saved.name} cadastrado.`);
      onSaved?.(saved);
      onOpenChange(false);
    },
    onError: (err) => {
      // Só vira painel quando o servidor devolveu os cadastros em conflito; corrida no índice único vem sem eles.
      if (err instanceof ApiError && err.code === 'whatsapp_duplicado' && err.conflicts?.length) {
        setError(null);
        setConflicts(err.conflicts);
        return;
      }
      const message = err instanceof ApiError ? err.message : 'Não foi possível salvar o cliente.';
      setError(message);
      // Erro de nome ou WhatsApp aparece na primeira aba; o resto é do cadastro completo.
      if (!/whatsapp|nome/i.test(message)) setTab('completo');
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    event.stopPropagation();
    // Sem "required" nos campos: na aba escondida o navegador bloquearia o envio sem dizer por quê.
    if (name.trim().length < 2 || !whatsapp.trim()) {
      setTab('contato');
      return setError(name.trim().length < 2 ? 'Informe o nome do cliente.' : 'Informe o WhatsApp do cliente.');
    }
    setError(null);
    mutation.mutate();
  }

  /** Reaproveita um cadastro já existente: nada é salvo, o pedido passa a usar o cliente que já estava lá. */
  function useExisting(existing: Client) {
    queryClient.invalidateQueries({ queryKey: ['clients'] });
    toast.success(`Usando o cadastro de ${existing.name}.`);
    onSaved?.(existing);
    onOpenChange(false);
  }

  if (conflicts) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Este WhatsApp já está cadastrado</DialogTitle>
            <DialogDescription>Este número já pertence a outro cliente. Escolha qual cadastro usar.</DialogDescription>
          </DialogHeader>
          <Alert variant="danger" icon={<TriangleAlert />} title="Nada foi salvo ainda.">
            <ul className="mt-1 grid gap-2">
              {conflicts.map((existing) => (
                <li
                  key={existing.id}
                  className="flex items-center justify-between gap-3 rounded-md border border-border bg-card px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate font-semibold">{existing.name}</p>
                    <p className="text-[13px] text-muted-foreground tabular-nums">{formatWhatsapp(existing.whatsapp)}</p>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => useExisting(existing)}>
                    Usar este cadastro
                  </Button>
                </li>
              ))}
            </ul>
          </Alert>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConflicts(null)}>
              Voltar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{client ? 'Editar cliente' : 'Novo cliente'}</DialogTitle>
          <DialogDescription>
            O orçamento em PDF é enviado para o WhatsApp. O cadastro completo é exigido na NF-e.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList>
              <TabsTrigger value="contato">
                <UserRound />
                Contato
              </TabsTrigger>
              <TabsTrigger value="completo">
                <FileText />
                Cadastro completo
              </TabsTrigger>
            </TabsList>

            <TabsContent value="contato" forceMount className="grid gap-4 data-[state=inactive]:hidden">
              <Field label={isCompany ? 'Nome / razão social' : 'Nome'} htmlFor="cliente-nome">
                <Input
                  id="cliente-nome"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="off"
                  autoFocus
                />
              </Field>
              <Field
                label="WhatsApp"
                htmlFor="cliente-whatsapp"
                error={tab === 'contato' ? error : null}
                hint="Com DDD. Número de outro país começa com +."
              >
                <Input
                  id="cliente-whatsapp"
                  value={whatsapp}
                  onChange={(e) => setWhatsapp(e.target.value)}
                  inputMode="tel"
                  autoComplete="off"
                  placeholder="(11) 98765-4321"
                  aria-invalid={Boolean(error && tab === 'contato') || undefined}
                />
              </Field>
              <Field
                label="Contato (opcional)"
                htmlFor="cliente-contato"
                hint={isCompany ? 'Quem compra pela empresa. As mensagens dizem "Olá" para ele.' : 'Com quem falar, se não for o próprio cliente.'}
              >
                <Input
                  id="cliente-contato"
                  value={contactName}
                  onChange={(e) => setContactName(e.target.value)}
                  maxLength={80}
                  autoComplete="off"
                />
              </Field>
            </TabsContent>

            <TabsContent value="completo" forceMount className="grid gap-4 data-[state=inactive]:hidden">
              {error && tab === 'completo' && <Alert variant="danger" title={error} />}
              <div className="grid gap-4 sm:grid-cols-[11rem_1fr]">
                <Field label="Tipo" htmlFor="cliente-tipo">
                  <NativeSelect
                    id="cliente-tipo"
                    value={details.person_type}
                    onChange={(e) => {
                      const type = e.target.value as 'F' | 'J';
                      setDetails((current) => ({
                        ...current,
                        person_type: type,
                        ie_indicator: type === 'F' ? '9' : current.ie_indicator,
                      }));
                    }}
                  >
                    <option value="F">Pessoa física</option>
                    <option value="J">Pessoa jurídica</option>
                  </NativeSelect>
                </Field>
                <Field label={isCompany ? 'CNPJ' : 'CPF'} htmlFor="cliente-documento">
                  <div className="flex gap-2">
                    <Input
                      id="cliente-documento"
                      value={details.document}
                      onChange={(e) => setDetail('document', e.target.value)}
                      placeholder={isCompany ? '00.000.000/0000-00' : '000.000.000-00'}
                      autoComplete="off"
                      className="tabular-nums uppercase"
                    />
                    {isCompany && (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => cnpjLookup.mutate()}
                        loading={cnpjLookup.isPending}
                        disabled={documentDigits.length !== 14}
                        title="Preencher com os dados da Receita Federal"
                      >
                        {!cnpjLookup.isPending && <Search />}
                        Buscar
                      </Button>
                    )}
                  </div>
                </Field>
              </div>

              {isCompany && (
                <Field label="Nome fantasia" htmlFor="cliente-fantasia">
                  <Input
                    id="cliente-fantasia"
                    value={details.trade_name}
                    onChange={(e) => setDetail('trade_name', e.target.value)}
                    maxLength={60}
                  />
                </Field>
              )}

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Indicador da IE" htmlFor="cliente-indicador-ie">
                  <NativeSelect
                    id="cliente-indicador-ie"
                    value={details.ie_indicator}
                    onChange={(e) => setDetail('ie_indicator', e.target.value)}
                  >
                    {IE_INDICATORS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
                <Field
                  label="Inscrição estadual"
                  htmlFor="cliente-ie"
                  hint={details.ie_indicator === '1' ? 'Obrigatória para contribuinte' : 'Opcional'}
                >
                  <Input
                    id="cliente-ie"
                    value={details.state_registration}
                    onChange={(e) => setDetail('state_registration', e.target.value)}
                    autoComplete="off"
                  />
                </Field>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="E-mail" htmlFor="cliente-email" hint="Recebe o XML da NF-e">
                  <Input
                    id="cliente-email"
                    type="email"
                    value={details.email}
                    onChange={(e) => setDetail('email', e.target.value)}
                    autoComplete="off"
                  />
                </Field>
                <Field label="Telefone" htmlFor="cliente-telefone" hint="Opcional; sem ele vai o WhatsApp">
                  <Input
                    id="cliente-telefone"
                    value={details.phone}
                    onChange={(e) => setDetail('phone', e.target.value)}
                    inputMode="tel"
                  />
                </Field>
              </div>

              <AddressFields idPrefix="cliente" value={address} onChange={setAddress} />

              <label className="flex items-start gap-2 text-sm">
                <Checkbox
                  className="mt-0.5"
                  checked={details.final_consumer}
                  onChange={(e) => setDetail('final_consumer', e.target.checked)}
                />
                <span>
                  Consumidor final
                  <span className="block text-[13px] text-muted-foreground">
                    Desmarque quando o cliente compra para revender.
                  </span>
                </span>
              </label>
            </TabsContent>
          </Tabs>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" loading={mutation.isPending}>
              {client ? 'Salvar cliente' : 'Cadastrar cliente'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
