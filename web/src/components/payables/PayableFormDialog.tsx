import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { useStoreOptions } from '@/pages/StockPage';
import { api, ApiError } from '@/lib/api';
import { useUser } from '@/lib/auth';
import { addDays, formatDay, formatMoney, moneyToInput, parseDecimal, todayIso } from '@/lib/format';
import { PAYABLE_CATEGORIES } from '@/lib/purchases';
import type { Payable } from '@/lib/types';
import { SupplierSelect } from '../purchases/SupplierSelect';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { Field, Input, NativeSelect } from '../ui/input';
import { Alert } from '../ui/misc';

/** Divide em parcelas de centavos inteiros; a diferença vai na primeira (como no contas a receber). */
function split(total: number, count: number) {
  const cents = Math.round(total * 100);
  const base = Math.floor(cents / count);
  return Array.from({ length: count }, (_, i) => (base + (i === 0 ? cents - base * count : 0)) / 100);
}

/** Nova conta a pagar (uma ou várias parcelas) ou correção de uma sem pagamento. */
export function PayableFormDialog({ open, onOpenChange, payable }: { open: boolean; onOpenChange: (open: boolean) => void; payable?: Payable | null }) {
  const user = useUser();
  const queryClient = useQueryClient();
  const stores = useStoreOptions(open);
  const [storeId, setStoreId] = useState('');
  const [supplierId, setSupplierId] = useState<number | null>(null);
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const [documentNumber, setDocumentNumber] = useState('');
  const [amount, setAmount] = useState('');
  const [dueDate, setDueDate] = useState(todayIso());
  const [count, setCount] = useState('1');
  const [intervalDays, setIntervalDays] = useState('30');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setStoreId(payable ? String(payable.store_id) : user.store_id ? String(user.store_id) : '');
    setSupplierId(payable?.supplier_id ?? null);
    setDescription(payable?.description ?? '');
    setCategory(payable?.category ?? '');
    setDocumentNumber(payable?.document_number ?? '');
    setAmount(payable ? moneyToInput(payable.amount) : '');
    setDueDate(payable?.due_date ?? todayIso());
    setCount('1');
    setIntervalDays('30');
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const total = parseDecimal(amount);
  const n = Math.max(1, Math.min(60, Number(count) || 1));
  const days = Math.max(1, Number(intervalDays) || 30);
  const installments =
    total && total > 0 && dueDate ? split(total, n).map((value, i) => ({ due_date: addDays(dueDate, i * days), amount: value })) : [];
  const currentStore = storeId || (stores.data?.[0] ? String(stores.data[0].id) : '');

  const save = useMutation({
    mutationFn: () => {
      const common = { description, category: category || null, document_number: documentNumber || null, supplier_id: supplierId };
      return payable
        ? api(`/payables/${payable.id}`, { method: 'PUT', body: { ...common, due_date: dueDate, amount: total } })
        : api('/payables', { method: 'POST', body: { ...common, store_id: Number(currentStore), installments } });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['payables'] });
      toast.success(payable ? 'Conta corrigida.' : n > 1 ? `${n} parcelas lançadas.` : 'Conta lançada.');
      onOpenChange(false);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Não foi possível salvar.'),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (description.trim().length < 2) return setError('Informe a descrição (ex.: Aluguel de outubro).');
    if (!total || total <= 0) return setError('Informe o valor.');
    if (!dueDate) return setError('Informe o vencimento.');
    if (!payable && !currentStore) return setError('Escolha a loja.');
    setError(null);
    save.mutate();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{payable ? 'Corrigir conta' : 'Nova conta a pagar'}</DialogTitle>
          <DialogDescription>Boleto de fornecedor, aluguel, energia, frete... A nota de compra lança as duplicatas sozinha.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          {error && <Alert variant="danger" title={error} />}
          <Field label="Descrição" htmlFor="conta-descricao">
            <Input id="conta-descricao" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={160} autoFocus />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Categoria" htmlFor="conta-categoria">
              <Input id="conta-categoria" list="conta-categorias" value={category} onChange={(e) => setCategory(e.target.value)} maxLength={60} />
              <datalist id="conta-categorias">
                {PAYABLE_CATEGORIES.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </Field>
            <Field label="Nº do documento" htmlFor="conta-documento">
              <Input id="conta-documento" value={documentNumber} onChange={(e) => setDocumentNumber(e.target.value)} maxLength={30} placeholder="NF, boleto..." />
            </Field>
          </div>
          <Field label="Fornecedor (opcional)" htmlFor="conta-fornecedor">
            <SupplierSelect id="conta-fornecedor" value={supplierId} onChange={(s) => setSupplierId(s?.id ?? null)} emptyLabel="Sem fornecedor" />
          </Field>
          {!payable && (stores.data?.length ?? 0) > 1 && (
            <Field label="Loja" htmlFor="conta-loja">
              <NativeSelect id="conta-loja" value={currentStore} onChange={(e) => setStoreId(e.target.value)}>
                {stores.data!.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={n > 1 && !payable ? 'Valor total' : 'Valor'} htmlFor="conta-valor">
              <Input id="conta-valor" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="tabular-nums" />
            </Field>
            <Field label={n > 1 && !payable ? '1º vencimento' : 'Vencimento'} htmlFor="conta-vencimento">
              <Input id="conta-vencimento" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </Field>
          </div>
          {!payable && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Parcelas" htmlFor="conta-parcelas">
                <Input id="conta-parcelas" type="number" min={1} max={60} value={count} onChange={(e) => setCount(e.target.value)} />
              </Field>
              {n > 1 && (
                <Field label="Dias entre parcelas" htmlFor="conta-intervalo">
                  <Input id="conta-intervalo" type="number" min={1} max={365} value={intervalDays} onChange={(e) => setIntervalDays(e.target.value)} />
                </Field>
              )}
            </div>
          )}
          {!payable && n > 1 && installments.length > 0 && (
            <ul className="grid gap-1 rounded-md bg-muted/60 px-3 py-2 text-[13px] tabular-nums">
              {installments.map((i, index) => (
                <li key={index} className="flex justify-between">
                  <span>
                    {index + 1}/{n} · {formatDay(i.due_date)}
                  </span>
                  <span>{formatMoney(i.amount)}</span>
                </li>
              ))}
            </ul>
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
