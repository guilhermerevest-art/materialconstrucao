import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { formatMoney, parseDecimal } from '@/lib/format';
import type { PriceAdjustResult } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Field, Input, NativeSelect } from './ui/input';
import { Alert } from './ui/misc';
import { Table, TBody, TD, TH, THead, TR } from './ui/table';

const ROUNDINGS = [
  { value: 'none', label: 'Não arredondar' },
  { value: '0.05', label: 'Para cima, de 0,05 em 0,05' },
  { value: '0.10', label: 'Para cima, de 0,10 em 0,10' },
  { value: '0.50', label: 'Para cima, de 0,50 em 0,50' },
  { value: '1.00', label: 'Para cima, de 1,00 em 1,00' },
];

const PREVIEW_ROWS = 50;

/**
 * Reajuste em massa: % sobre o preço atual ou margem sobre o último custo, com
 * arredondamento. Mostra o antes e depois; só grava ao confirmar.
 */
export function PriceAdjustDialog({ search, onClose }: { search: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [scope, setScope] = useState<'all' | 'search'>(search ? 'search' : 'all');
  const [mode, setMode] = useState<'percent' | 'markup'>('percent');
  const [percentText, setPercentText] = useState('');
  const [rounding, setRounding] = useState('0.10');
  const [preview, setPreview] = useState<PriceAdjustResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const body = (apply: boolean) => {
    const percent = percentText.trim() ? parseDecimal(percentText) : null;
    return { q: scope === 'search' ? search : null, mode, percent, rounding, apply };
  };

  const run = useMutation({
    mutationFn: (apply: boolean) => api<PriceAdjustResult>('/products/price-adjust', { method: 'POST', body: body(apply) }),
    onSuccess: (result) => {
      if (!result.applied) return setPreview(result);
      queryClient.invalidateQueries({ queryKey: ['products'] });
      queryClient.invalidateQueries({ queryKey: ['product-pricing'] });
      toast.success(`${result.count} ${result.count === 1 ? 'preço reajustado' : 'preços reajustados'}.`);
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Não foi possível reajustar.'),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (mode === 'percent' && (!percentText.trim() || parseDecimal(percentText) === null)) {
      return setError('Informe o percentual. Exemplo: 5 para aumentar 5%, -3 para baixar 3%.');
    }
    if (mode === 'markup' && percentText.trim() && parseDecimal(percentText) === null) return setError('Margem inválida. Exemplo: 35');
    setError(null);
    run.mutate(false);
  }

  // Qualquer mudança nos campos invalida a prévia.
  const changed = <T,>(setter: (value: T) => void) => (value: T) => {
    setter(value);
    setPreview(null);
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Reajustar preços</DialogTitle>
          <DialogDescription>Veja o antes e depois e confirme. Pedidos já lançados não mudam; tudo fica no histórico de preço.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          {error && <Alert variant="danger" title={error} />}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Produtos" htmlFor="reajuste-escopo">
              <NativeSelect id="reajuste-escopo" value={scope} onChange={(e) => changed(setScope)(e.target.value as typeof scope)}>
                <option value="all">Todos os produtos ativos</option>
                {search && <option value="search">Só os da busca "{search}"</option>}
              </NativeSelect>
            </Field>
            <Field label="Como" htmlFor="reajuste-modo">
              <NativeSelect id="reajuste-modo" value={mode} onChange={(e) => changed(setMode)(e.target.value as typeof mode)}>
                <option value="percent">% sobre o preço atual</option>
                <option value="markup">Margem sobre o último custo</option>
              </NativeSelect>
            </Field>
            <Field
              label={mode === 'percent' ? 'Percentual (%)' : 'Margem (%)'}
              htmlFor="reajuste-percentual"
              hint={mode === 'percent' ? 'Negativo baixa o preço.' : 'Em branco, usa a margem de cada produto (ou a padrão).'}
            >
              <Input
                id="reajuste-percentual"
                inputMode="decimal"
                value={percentText}
                onChange={(e) => changed(setPercentText)(e.target.value)}
                className="text-right tabular-nums"
                autoFocus
              />
            </Field>
            <Field label="Arredondar" htmlFor="reajuste-arredondar">
              <NativeSelect id="reajuste-arredondar" value={rounding} onChange={(e) => changed(setRounding)(e.target.value)}>
                {ROUNDINGS.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          </div>

          {preview && (
            <div className="grid gap-2">
              <p className="text-sm">
                <strong>{preview.count}</strong> {preview.count === 1 ? 'produto muda' : 'produtos mudam'} de preço
                {preview.skipped > 0 && ` · ${preview.skipped} sem custo ou margem ficam como estão`}.
              </p>
              {preview.count > 0 && (
                <div className="max-h-72 overflow-y-auto rounded-md border border-border">
                  <Table>
                    <THead>
                      <TR>
                        <TH className="pl-3">Produto</TH>
                        <TH className="text-right">Atual</TH>
                        <TH className="pr-3 text-right">Novo</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {preview.items.slice(0, PREVIEW_ROWS).map((item) => (
                        <TR key={item.id}>
                          <TD className="pl-3">
                            {item.name}
                            {item.code && <span className="ml-2 text-xs text-muted-foreground">{item.code}</span>}
                          </TD>
                          <TD className="text-right text-muted-foreground tabular-nums">{formatMoney(item.old_price)}</TD>
                          <TD
                            className={cn(
                              'pr-3 text-right font-semibold tabular-nums',
                              item.new_price < item.old_price && 'text-destructive',
                            )}
                          >
                            {formatMoney(item.new_price)}
                          </TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                  {preview.count > PREVIEW_ROWS && (
                    <p className="border-t border-border px-3 py-2 text-[13px] text-muted-foreground">
                      E mais {preview.count - PREVIEW_ROWS} produtos.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancelar
            </Button>
            {preview && preview.count > 0 ? (
              <Button type="button" loading={run.isPending} onClick={() => run.mutate(true)}>
                Aplicar em {preview.count} {preview.count === 1 ? 'produto' : 'produtos'}
              </Button>
            ) : (
              <Button type="submit" loading={run.isPending}>
                Ver prévia
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
