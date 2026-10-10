import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import type { Paginated, Supplier } from '@/lib/types';
import { Button } from '../ui/button';
import { NativeSelect } from '../ui/input';
import { SupplierFormDialog } from './SupplierFormDialog';

/** Fornecedores ativos (para escolher). */
export function useSuppliers(enabled = true) {
  return useQuery({
    queryKey: ['suppliers', 'options'],
    queryFn: () => api<Paginated<Supplier>>('/suppliers?page_size=100').then((r) => r.items),
    enabled,
  });
}

/** Escolha do fornecedor, com o cadastro rápido de um novo ao lado. */
export function SupplierSelect({
  id,
  value,
  onChange,
  emptyLabel = 'Escolha o fornecedor',
  invalid,
}: {
  id: string;
  value: number | null;
  onChange: (supplier: Supplier | null) => void;
  emptyLabel?: string;
  invalid?: boolean;
}) {
  const suppliers = useSuppliers();
  const [creating, setCreating] = useState(false);
  const items = suppliers.data ?? [];
  return (
    <div className="flex gap-2">
      <NativeSelect
        id={id}
        value={value ?? ''}
        aria-invalid={invalid || undefined}
        onChange={(e) => onChange(items.find((s) => s.id === Number(e.target.value)) ?? null)}
        className="min-w-0 flex-1"
      >
        <option value="">{suppliers.isPending ? 'Carregando...' : emptyLabel}</option>
        {items.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </NativeSelect>
      <Button type="button" variant="outline" size="icon" className="size-10 shrink-0" onClick={() => setCreating(true)} aria-label="Novo fornecedor" title="Novo fornecedor">
        <Plus />
      </Button>
      <SupplierFormDialog open={creating} onOpenChange={setCreating} onSaved={(s) => onChange(s)} />
    </div>
  );
}
