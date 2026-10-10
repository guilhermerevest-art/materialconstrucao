import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { formatDocument } from '@/lib/fiscal';
import { formatWhatsapp } from '@/lib/format';
import type { Supplier } from '@/lib/types';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { Checkbox, Field, Input, Textarea } from '../ui/input';
import { Alert } from '../ui/misc';

type Form = { name: string; document: string; contact_name: string; whatsapp: string; email: string; notes: string; active: boolean };

const toForm = (s: Supplier | null | undefined): Form => ({
  name: s?.name ?? '',
  document: formatDocument(s?.document),
  contact_name: s?.contact_name ?? '',
  whatsapp: s?.whatsapp ? formatWhatsapp(s.whatsapp) : '',
  email: s?.email ?? '',
  notes: s?.notes ?? '',
  active: s?.active ?? true,
});

/** Cadastro e edição de fornecedor. O CNPJ completo busca a razão social na Receita (com o fiscal configurado). */
export function SupplierFormDialog({
  open,
  onOpenChange,
  supplier,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  supplier?: Supplier | null;
  onSaved?: (supplier: Supplier) => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<Form>(() => toForm(supplier));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setForm(toForm(supplier));
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));
  const digits = form.document.replace(/\D/g, '');

  const lookup = useMutation({
    mutationFn: () =>
      api<{ company: { legal_name: string | null; trade_name: string | null; email: string | null } }>(`/fiscal/lookup/cnpj/${digits}`),
    onSuccess: ({ company }) => {
      setForm((f) => ({
        ...f,
        name: company.trade_name || company.legal_name || f.name,
        email: f.email || (company.email ?? ''),
      }));
      toast.success('Dados da Receita preenchidos. Confira antes de salvar.');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Não foi possível consultar o CNPJ.'),
  });

  const save = useMutation({
    mutationFn: () => {
      const body = { ...form, document: digits || null };
      return supplier
        ? api<{ supplier: Supplier }>(`/suppliers/${supplier.id}`, { method: 'PUT', body })
        : api<{ supplier: Supplier }>('/suppliers', { method: 'POST', body });
    },
    onSuccess: ({ supplier: saved }) => {
      queryClient.invalidateQueries({ queryKey: ['suppliers'] });
      toast.success(supplier ? 'Fornecedor atualizado.' : `${saved.name} cadastrado.`);
      onSaved?.(saved);
      onOpenChange(false);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Não foi possível salvar o fornecedor.'),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (form.name.trim().length < 2) return setError('Informe o nome do fornecedor.');
    if (digits && digits.length !== 11 && digits.length !== 14) return setError('CNPJ ou CPF incompleto.');
    setError(null);
    save.mutate();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{supplier ? 'Editar fornecedor' : 'Novo fornecedor'}</DialogTitle>
          <DialogDescription>O WhatsApp é para mandar o pedido de compra. A nota de compra cadastra o fornecedor sozinha pelo CNPJ.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          {error && <Alert variant="danger" title={error} />}
          <Field label="CNPJ ou CPF" htmlFor="fornecedor-documento">
            <div className="flex gap-2">
              <Input
                id="fornecedor-documento"
                inputMode="numeric"
                value={form.document}
                onChange={(e) => set('document', e.target.value)}
                maxLength={18}
                className="flex-1"
              />
              <Button
                type="button"
                variant="outline"
                disabled={digits.length !== 14}
                loading={lookup.isPending}
                onClick={() => lookup.mutate()}
                title="Preenche com os dados da Receita Federal"
              >
                <Search />
                Receita
              </Button>
            </div>
          </Field>
          <Field label="Nome" htmlFor="fornecedor-nome">
            <Input id="fornecedor-nome" value={form.name} onChange={(e) => set('name', e.target.value)} maxLength={120} autoFocus />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Contato (vendedor)" htmlFor="fornecedor-contato">
              <Input id="fornecedor-contato" value={form.contact_name} onChange={(e) => set('contact_name', e.target.value)} maxLength={80} />
            </Field>
            <Field label="WhatsApp" htmlFor="fornecedor-whatsapp">
              <Input
                id="fornecedor-whatsapp"
                inputMode="tel"
                value={form.whatsapp}
                onChange={(e) => set('whatsapp', e.target.value)}
                placeholder="(11) 98765-4321"
                maxLength={30}
              />
            </Field>
          </div>
          <Field label="E-mail" htmlFor="fornecedor-email">
            <Input id="fornecedor-email" type="email" value={form.email} onChange={(e) => set('email', e.target.value)} maxLength={120} />
          </Field>
          <Field label="Observações" htmlFor="fornecedor-obs">
            <Textarea
              id="fornecedor-obs"
              rows={2}
              value={form.notes}
              onChange={(e) => set('notes', e.target.value)}
              maxLength={500}
              placeholder="Prazo de entrega, pedido mínimo, condição de pagamento..."
            />
          </Field>
          {supplier && (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={form.active} onChange={(e) => set('active', e.target.checked)} />
              Ativo (inativo não aparece para novos pedidos)
            </label>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" loading={save.isPending}>
              Salvar
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
