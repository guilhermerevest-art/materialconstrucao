import { Plus, Trash2 } from 'lucide-react';
import { decimalToInput, formatDateTime, formatMoney, formatPercent, moneyToInput, parseDecimal } from '@/lib/format';
import type { ProductPricing } from '@/lib/types';
import { Button } from './ui/button';
import { Field, Input } from './ui/input';

export type PricingForm = { markup: string; tiers: { quantity: string; price: string }[] };

export const emptyPricingForm: PricingForm = { markup: '', tiers: [] };

export function pricingToForm(pricing: ProductPricing | undefined): PricingForm {
  if (!pricing) return emptyPricingForm;
  return {
    markup: pricing.markup_percent != null ? decimalToInput(pricing.markup_percent) : '',
    tiers: pricing.tiers.map((t) => ({ quantity: decimalToInput(t.min_quantity), price: moneyToInput(t.price) })),
  };
}

/** Corpo do PUT /products/:id/pricing, ou a mensagem do que está errado. */
export function pricingToBody(form: PricingForm): { body: { markup_percent: number | null; tiers: { min_quantity: number; price: number }[] } } | { invalid: string } {
  const markup = form.markup.trim() ? parseDecimal(form.markup) : null;
  if (form.markup.trim() && (markup === null || markup < 0)) return { invalid: 'Margem inválida. Exemplo: 35' };
  const tiers = [];
  for (const tier of form.tiers) {
    if (!tier.quantity.trim() && !tier.price.trim()) continue;
    const quantity = parseDecimal(tier.quantity);
    const price = parseDecimal(tier.price);
    if (quantity === null || quantity <= 0) return { invalid: 'Quantidade da faixa inválida. Exemplo: 50' };
    if (price === null || price < 0) return { invalid: 'Preço da faixa inválido. Exemplo: 36,90' };
    tiers.push({ min_quantity: quantity, price: Math.round(price * 100) / 100 });
  }
  return { body: { markup_percent: markup, tiers } };
}

/** Aba "Preço" do produto: margem sobre o custo, faixas por quantidade e o histórico. */
export function ProductPricingTab({
  value,
  onChange,
  pricing,
  unit,
  onUseSuggested,
}: {
  value: PricingForm;
  onChange: (next: PricingForm) => void;
  pricing: ProductPricing | undefined;
  unit: string;
  onUseSuggested: (price: number) => void;
}) {
  const markup = value.markup.trim() ? parseDecimal(value.markup) : (pricing?.default_markup_percent ?? null);
  const cost = pricing?.cost_price ?? null;
  const suggested = cost !== null && markup !== null ? Math.round(cost * (1 + markup / 100) * 100) / 100 : null;
  const setTier = (index: number, key: 'quantity' | 'price', text: string) =>
    onChange({ ...value, tiers: value.tiers.map((t, i) => (i === index ? { ...t, [key]: text } : t)) });

  return (
    <div className="grid gap-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid content-start gap-1.5 text-sm">
          <span className="font-medium">Último custo</span>
          <span className="tabular-nums">{cost !== null ? `${formatMoney(cost)} / ${unit}` : 'Sem custo ainda (vem da entrada de nota).'}</span>
        </div>
        <Field
          label="Margem sobre o custo (%)"
          htmlFor="produto-margem"
          hint={
            pricing?.default_markup_percent != null
              ? `Em branco, usa a padrão da loja (${formatPercent(pricing.default_markup_percent)}).`
              : 'Para sugerir o preço na entrada de nota e no reajuste.'
          }
        >
          <Input
            id="produto-margem"
            inputMode="decimal"
            value={value.markup}
            onChange={(e) => onChange({ ...value, markup: e.target.value })}
            className="text-right tabular-nums"
            placeholder={pricing?.default_markup_percent != null ? decimalToInput(pricing.default_markup_percent) : ''}
          />
        </Field>
      </div>
      {suggested !== null && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
          <span>
            Preço sugerido: <strong className="tabular-nums">{formatMoney(suggested)}</strong>
          </span>
          <Button type="button" size="sm" variant="outline" onClick={() => onUseSuggested(suggested)}>
            Usar como preço
          </Button>
        </div>
      )}

      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium">Preço por quantidade</legend>
        <p className="text-[13px] text-muted-foreground">
          A partir da quantidade, o item sai pelo preço da faixa. Com tabela de preço, vale o menor dos dois.
        </p>
        {value.tiers.map((tier, index) => (
          <div key={index} className="flex flex-wrap items-end gap-2">
            <Field label={`A partir de (${unit})`} htmlFor={`faixa-qtd-${index}`} className="w-36">
              <Input
                id={`faixa-qtd-${index}`}
                inputMode="decimal"
                value={tier.quantity}
                onChange={(e) => setTier(index, 'quantity', e.target.value)}
                className="text-right tabular-nums"
              />
            </Field>
            <Field label="Preço (R$)" htmlFor={`faixa-preco-${index}`} className="w-36">
              <Input
                id={`faixa-preco-${index}`}
                inputMode="decimal"
                value={tier.price}
                onChange={(e) => setTier(index, 'price', e.target.value)}
                className="text-right tabular-nums"
              />
            </Field>
            <Button
              type="button"
              variant="destructive-ghost"
              size="icon"
              aria-label={`Remover faixa ${index + 1}`}
              onClick={() => onChange({ ...value, tiers: value.tiers.filter((_, i) => i !== index) })}
            >
              <Trash2 />
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="justify-self-start"
          onClick={() => onChange({ ...value, tiers: [...value.tiers, { quantity: '', price: '' }] })}
          disabled={value.tiers.length >= 20}
        >
          <Plus />
          Adicionar faixa
        </Button>
      </fieldset>

      {pricing && pricing.history.length > 0 && (
        <div className="grid gap-1.5">
          <span className="text-sm font-medium">Histórico de preço</span>
          <ul className="grid gap-1 text-[13px] text-muted-foreground">
            {pricing.history.map((h, i) => (
              <li key={i}>
                <span className="tabular-nums">{formatDateTime(h.created_at)}</span> · {formatMoney(h.old_price)} →{' '}
                <span className="font-medium text-foreground tabular-nums">{formatMoney(h.new_price)}</span>
                {h.reason ? ` · ${h.reason}` : ''}
                {h.user_name ? ` · ${h.user_name}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
