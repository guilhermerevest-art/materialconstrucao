import { Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { centsToMoney, decimalToInput, formatMoney, lineTotalCents, parseDecimal } from '@/lib/format';
import { cn } from '@/lib/utils';

export type CartItem = {
  product_id: number;
  code: string | null;
  name: string;
  unit: string;
  unit_price: number;
  quantity: number;
  /** De onde veio o preço, quando não é o do catálogo ("Tabela Atacado", "Faixa 50+"). */
  price_note?: string | null;
  /** Próxima faixa, para o vendedor oferecer ("A partir de 50: R$ 36,90"). */
  tier_hint?: string | null;
};

/** Origem do preço e a próxima faixa, embaixo do preço. */
function PriceNotes({ item, className }: { item: CartItem; className?: string }) {
  if (!item.price_note && !item.tier_hint) return null;
  return (
    <span className={cn('block text-xs leading-snug', className)}>
      {item.price_note && <span className="block text-success">{item.price_note}</span>}
      {item.tier_hint && <span className="block text-muted-foreground">{item.tier_hint}</span>}
    </span>
  );
}

const toQuantity = (text: string) => {
  const parsed = parseDecimal(text);
  return parsed === null || parsed <= 0 || parsed > 999_999 ? null : Math.round(parsed * 1000) / 1000;
};

/**
 * Quantidade editável na linha. Vale enquanto se digita, então F9 com o cursor
 * no campo já salva o número novo. Valor inválido volta ao anterior ao sair do campo.
 */
function QuantityInput({ value, label, onCommit }: { value: number; label: string; onCommit: (value: number) => void }) {
  const [text, setText] = useState(decimalToInput(value));
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setText(decimalToInput(value));
  }, [value]);
  const invalid = toQuantity(text) === null;

  return (
    <Input
      value={text}
      aria-label={label}
      aria-invalid={invalid || undefined}
      inputMode="decimal"
      autoComplete="off"
      onFocus={() => {
        editing.current = true;
      }}
      onChange={(e) => {
        setText(e.target.value);
        const quantity = toQuantity(e.target.value);
        if (quantity !== null && quantity !== value) onCommit(quantity);
      }}
      onBlur={() => {
        editing.current = false;
        setText(decimalToInput(value));
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
      className="h-9 w-24 text-right tabular-nums"
    />
  );
}

export function CartTable({
  items,
  onQuantityChange,
  onRemove,
}: {
  items: CartItem[];
  onQuantityChange: (productId: number, quantity: number) => void;
  onRemove: (productId: number) => void;
}) {
  if (items.length === 0) {
    return (
      <div className="mx-5 mb-5 rounded-md border border-dashed border-input px-4 py-8 text-center text-sm text-muted-foreground">
        Nenhum produto no carrinho. Busque pelo nome ou código e tecle Enter.
      </div>
    );
  }

  return (
    <>
      {/* Mobile: cards empilhados para caber em tela estreita sem scroll horizontal. */}
      <ul className="grid gap-2 px-4 pb-4 sm:hidden">
        {items.map((item, index) => (
          <li
            key={item.product_id}
            className={cn(
              'grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 gap-y-2 rounded-md border border-border bg-card p-3',
              index % 2 === 1 && 'bg-background/50',
            )}
          >
            <div className="min-w-0">
              <p className="truncate font-medium">{item.name}</p>
              {item.code && <p className="truncate text-xs text-muted-foreground">{item.code}</p>}
              <p className="mt-1 text-xs text-muted-foreground tabular-nums">
                {item.quantity} {item.unit} × {formatMoney(item.unit_price)}
              </p>
              <PriceNotes item={item} />
            </div>
            <Button
              variant="destructive-ghost"
              size="icon"
              className="size-8 self-start"
              onClick={() => onRemove(item.product_id)}
              aria-label={`Remover ${item.name}`}
            >
              <Trash2 />
            </Button>
            <div className="col-span-2 flex items-center justify-between border-t border-border pt-2">
              <QuantityInput
                value={item.quantity}
                label={`Quantidade de ${item.name}`}
                onCommit={(quantity) => onQuantityChange(item.product_id, quantity)}
              />
              <span className="text-right font-semibold tabular-nums">
                {centsToMoney(lineTotalCents(item.unit_price, item.quantity))}
              </span>
            </div>
          </li>
        ))}
      </ul>

      {/* sm em diante: tabela tradicional. */}
      <Table className="hidden sm:table">
        <THead>
          <TR>
            <TH className="w-10 pl-5">#</TH>
            <TH>Produto</TH>
            <TH className="w-14 text-center">Un.</TH>
            <TH className="w-28 text-right">Qtd.</TH>
            <TH className="w-28 text-right">Preço unit.</TH>
            <TH className="w-32 text-right">Subtotal</TH>
            <TH className="w-14 pr-5">
              <span className="sr-only">Remover</span>
            </TH>
          </TR>
        </THead>
        <TBody>
          {items.map((item, index) => (
            <TR key={item.product_id} className={cn(index % 2 === 1 && 'bg-background/50')}>
              <TD className="pl-5 text-muted-foreground tabular-nums">{index + 1}</TD>
              <TD className="py-2">
                <p className="font-medium">{item.name}</p>
                {item.code && <p className="text-xs text-muted-foreground">{item.code}</p>}
              </TD>
              <TD className="text-center text-muted-foreground">{item.unit}</TD>
              <TD className="text-right">
                <div className="flex justify-end">
                  <QuantityInput
                    value={item.quantity}
                    label={`Quantidade de ${item.name}`}
                    onCommit={(quantity) => onQuantityChange(item.product_id, quantity)}
                  />
                </div>
              </TD>
              <TD className="text-right tabular-nums">
                {formatMoney(item.unit_price)}
                <PriceNotes item={item} className="max-w-40 whitespace-normal" />
              </TD>
              <TD className="text-right font-semibold tabular-nums">
                {centsToMoney(lineTotalCents(item.unit_price, item.quantity))}
              </TD>
              <TD className="pr-5 text-right">
                <Button
                  variant="destructive-ghost"
                  size="icon"
                  className="size-8"
                  onClick={() => onRemove(item.product_id)}
                  aria-label={`Remover ${item.name}`}
                >
                  <Trash2 />
                </Button>
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </>
  );
}
