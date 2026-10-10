import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BadgePercent } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { ME_KEY } from '@/lib/auth';
import { decimalToInput, parseDecimal } from '@/lib/format';
import type { SalesSettings } from '@/lib/types';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Field, Input } from './ui/input';
import { Alert, Skeleton } from './ui/misc';

const toText = (value: number | null) => (value != null ? decimalToInput(value) : '');

/** Padrão da loja para a venda: desconto máximo de quem vende e margem sobre o custo. */
export function SalesSettingsCard() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['sales-settings'],
    queryFn: () => api<{ settings: SalesSettings }>('/sales-settings').then((r) => r.settings),
  });
  const [discount, setDiscount] = useState('');
  const [markup, setMarkup] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!query.data) return;
    setDiscount(toText(query.data.max_discount_percent));
    setMarkup(toText(query.data.default_markup_percent));
  }, [query.data]);

  const save = useMutation({
    mutationFn: (body: SalesSettings) => api<{ settings: SalesSettings }>('/sales-settings', { method: 'PUT', body }),
    onSuccess: ({ settings }) => {
      queryClient.setQueryData(['sales-settings'], settings);
      queryClient.invalidateQueries({ queryKey: ME_KEY });
      toast.success('Padrões de venda salvos.');
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Não foi possível salvar.'),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const maxDiscount = discount.trim() ? parseDecimal(discount) : null;
    const defaultMarkup = markup.trim() ? parseDecimal(markup) : null;
    if (discount.trim() && (maxDiscount === null || maxDiscount < 0 || maxDiscount > 100)) return setError('Desconto máximo de 0 a 100%.');
    if (markup.trim() && (defaultMarkup === null || defaultMarkup < 0)) return setError('Margem inválida. Exemplo: 35');
    setError(null);
    save.mutate({ max_discount_percent: maxDiscount, default_markup_percent: defaultMarkup });
  }

  return (
    <Card>
      <CardHeader className="items-start">
        <div className="flex items-start gap-3">
          <BadgePercent className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
          <div className="grid gap-0.5">
            <CardTitle>Vendas</CardTitle>
            <CardDescription>Padrões da loja. Cada vendedor pode ter o próprio limite em Administração → Vendedores.</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {query.isPending ? (
          <Skeleton className="h-32" />
        ) : (
          <form onSubmit={submit} className="grid gap-4">
            {error && <Alert variant="danger" title={error} />}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Desconto máximo do vendedor (%)"
                htmlFor="vendas-desconto"
                hint="Em branco, sem limite. Acima do limite, quem pode liberar digita a senha no PDV."
              >
                <Input id="vendas-desconto" inputMode="decimal" value={discount} onChange={(e) => setDiscount(e.target.value)} className="text-right tabular-nums" />
              </Field>
              <Field
                label="Margem padrão sobre o custo (%)"
                htmlFor="vendas-margem"
                hint="Sugere o preço na entrada de nota e no reajuste por margem. Cada produto pode ter a sua."
              >
                <Input id="vendas-margem" inputMode="decimal" value={markup} onChange={(e) => setMarkup(e.target.value)} className="text-right tabular-nums" />
              </Field>
            </div>
            <Button type="submit" className="justify-self-start" loading={save.isPending}>
              Salvar padrões
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
