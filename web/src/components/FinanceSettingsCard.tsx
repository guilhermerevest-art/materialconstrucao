import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Landmark } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { ME_KEY } from '@/lib/auth';
import type { FinanceSettings } from '@/lib/types';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Checkbox, Field, Input } from './ui/input';
import { Alert, Skeleton } from './ui/misc';

/** Liga o financeiro (contas a receber e caixa) e configura o PIX da loja. */
export function FinanceSettingsCard() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['finance-settings'],
    queryFn: () => api<{ settings: FinanceSettings }>('/finance/settings').then((r) => r.settings),
  });
  const [enabled, setEnabled] = useState(false);
  const [pixKey, setPixKey] = useState('');
  const [name, setName] = useState('');
  const [city, setCity] = useState('');

  useEffect(() => {
    if (!query.data) return;
    setEnabled(query.data.finance_enabled);
    setPixKey(query.data.pix_key ?? '');
    setName(query.data.pix_merchant_name ?? '');
    setCity(query.data.pix_city ?? '');
  }, [query.data]);

  const save = useMutation({
    mutationFn: () =>
      api<{ settings: FinanceSettings }>('/finance/settings', {
        method: 'PUT',
        body: { finance_enabled: enabled, pix_key: pixKey, pix_merchant_name: name, pix_city: city },
      }),
    onSuccess: ({ settings }) => {
      queryClient.setQueryData(['finance-settings'], settings);
      // O menu e as telas leem o financeiro da sessão.
      queryClient.invalidateQueries({ queryKey: ME_KEY });
      toast.success('Financeiro salvo.');
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    save.mutate();
  }

  return (
    <Card className="mt-6">
      <CardHeader className="items-start">
        <div className="flex items-start gap-3">
          <Landmark className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
          <div className="grid gap-0.5">
            <CardTitle>Financeiro</CardTitle>
            <CardDescription>
              Opcional. Desligado, a venda funciona como sempre. Ligado, cada pedido confirmado gera as parcelas da forma de pagamento,
              recebidas no Caixa, e o crediário passa a respeitar o limite de cada cliente.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {query.isPending ? (
          <Skeleton className="h-32" />
        ) : (
          <form onSubmit={submit} className="grid gap-4">
            {save.error && <Alert variant="danger" title={save.error instanceof ApiError ? save.error.message : 'Não foi possível salvar.'} />}
            <label className="flex items-center gap-2 text-sm font-medium">
              <Checkbox checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
              Ligar contas a receber e caixa
            </label>
            <fieldset className="grid gap-3 rounded-md border border-border p-4">
              <legend className="px-1 text-sm font-medium">PIX da loja</legend>
              <p className="text-[13px] text-muted-foreground">
                Com a chave, o caixa mostra o QR Code com o valor e o PDF do pedido pago no PIX sai com o QR Code. Funciona mesmo com o
                financeiro desligado. A confirmação do pagamento é feita olhando o extrato do banco.
              </p>
              <Field label="Chave PIX" htmlFor="pix-chave" hint="CPF, CNPJ, e-mail, telefone ou chave aleatória.">
                <Input id="pix-chave" value={pixKey} onChange={(e) => setPixKey(e.target.value)} maxLength={120} autoComplete="off" />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Nome do recebedor" htmlFor="pix-nome" hint="Como está no banco (até 25 letras).">
                  <Input id="pix-nome" value={name} onChange={(e) => setName(e.target.value)} maxLength={25} />
                </Field>
                <Field label="Cidade" htmlFor="pix-cidade" hint="Até 15 letras.">
                  <Input id="pix-cidade" value={city} onChange={(e) => setCity(e.target.value)} maxLength={15} />
                </Field>
              </div>
            </fieldset>
            <Button type="submit" className="justify-self-start" loading={save.isPending}>
              Salvar financeiro
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
