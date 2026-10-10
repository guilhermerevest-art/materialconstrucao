import { FileText } from 'lucide-react';
import type { Delivery } from '@/lib/types';

/** Número da nota do pedido; abre o DANFE (o motorista leva junto com a mercadoria). */
export function InvoiceLink({ invoice }: { invoice: NonNullable<Delivery['invoice']> }) {
  return (
    <a
      href={`/api/fiscal/documents/${invoice.id}/pdf`}
      target="_blank"
      rel="noreferrer"
      title="Abrir o DANFE"
      className="inline-flex items-center gap-1 rounded-full bg-success-soft px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap text-success hover:underline"
    >
      <FileText className="size-3" aria-hidden />
      {invoice.model === 65 ? 'NFC-e' : 'NF-e'} {invoice.number}
    </a>
  );
}
