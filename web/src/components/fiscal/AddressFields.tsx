import { useMutation } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Field, Input, NativeSelect } from '@/components/ui/input';
import { api, ApiError } from '@/lib/api';
import { formatZip, UFS, type AddressForm } from '@/lib/fiscal';
import type { FiscalAddress } from '@/lib/types';

/** Junta o que veio de uma consulta (CEP ou CNPJ) sem apagar o que já foi digitado. */
export function mergeAddress(current: AddressForm, found: Partial<FiscalAddress>): AddressForm {
  const next = { ...current };
  for (const key of Object.keys(current) as (keyof AddressForm)[]) {
    const value = found[key];
    if (value) next[key] = key === 'address_zip' ? formatZip(value) : value;
  }
  return next;
}

/** Endereço no formato da NF-e. "Buscar" preenche pelo CEP, inclusive o código IBGE. */
export function AddressFields({
  idPrefix,
  value,
  onChange,
}: {
  idPrefix: string;
  value: AddressForm;
  onChange: Dispatch<SetStateAction<AddressForm>>;
}) {
  const set = (key: keyof AddressForm) => (event: { target: { value: string } }) =>
    onChange((current) => ({ ...current, [key]: event.target.value }));

  const lookup = useMutation({
    mutationFn: (cep: string) => api<{ address: Partial<FiscalAddress> }>(`/fiscal/lookup/cep/${cep}`),
    onSuccess: ({ address }) => {
      onChange((current) => mergeAddress(current, address));
      toast.success('Endereço preenchido pelo CEP. Confira o número.');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Não foi possível consultar o CEP.'),
  });

  const cep = value.address_zip.replace(/\D/g, '');

  return (
    <div className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-[12rem_1fr]">
        <Field label="CEP" htmlFor={`${idPrefix}-cep`}>
          <div className="flex gap-2">
            <Input
              id={`${idPrefix}-cep`}
              value={value.address_zip}
              onChange={set('address_zip')}
              inputMode="numeric"
              placeholder="00000-000"
              autoComplete="off"
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-10"
              disabled={cep.length !== 8}
              loading={lookup.isPending}
              onClick={() => lookup.mutate(cep)}
              aria-label="Buscar endereço pelo CEP"
              title="Buscar endereço pelo CEP"
            >
              {!lookup.isPending && <Search />}
            </Button>
          </div>
        </Field>
        <Field label="Logradouro" htmlFor={`${idPrefix}-rua`}>
          <Input id={`${idPrefix}-rua`} value={value.address_street} onChange={set('address_street')} maxLength={60} />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-[8rem_1fr_1fr]">
        <Field label="Número" htmlFor={`${idPrefix}-numero`} hint="S/N se não houver">
          <Input id={`${idPrefix}-numero`} value={value.address_number} onChange={set('address_number')} maxLength={60} />
        </Field>
        <Field label="Complemento" htmlFor={`${idPrefix}-complemento`}>
          <Input
            id={`${idPrefix}-complemento`}
            value={value.address_complement}
            onChange={set('address_complement')}
            maxLength={60}
          />
        </Field>
        <Field label="Bairro" htmlFor={`${idPrefix}-bairro`}>
          <Input id={`${idPrefix}-bairro`} value={value.address_district} onChange={set('address_district')} maxLength={60} />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-[1fr_10rem_6rem]">
        <Field label="Município" htmlFor={`${idPrefix}-cidade`}>
          <Input id={`${idPrefix}-cidade`} value={value.address_city} onChange={set('address_city')} maxLength={60} />
        </Field>
        <Field label="Código IBGE" htmlFor={`${idPrefix}-ibge`} hint="7 dígitos; vem pelo CEP">
          <Input
            id={`${idPrefix}-ibge`}
            value={value.address_city_code}
            onChange={set('address_city_code')}
            inputMode="numeric"
            maxLength={7}
            className="tabular-nums"
          />
        </Field>
        <Field label="UF" htmlFor={`${idPrefix}-uf`}>
          <NativeSelect id={`${idPrefix}-uf`} value={value.address_state} onChange={set('address_state')}>
            <option value="">—</option>
            {UFS.map((uf) => (
              <option key={uf} value={uf}>
                {uf}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>
    </div>
  );
}
