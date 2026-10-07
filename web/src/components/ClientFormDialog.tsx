import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { formatWhatsapp } from '@/lib/format';
import type { Client } from '@/lib/types';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Field, Input } from './ui/input';

/** Cadastro e edição de cliente. Usado na tela de clientes e no PDV (cadastro rápido). */
export function ClientFormDialog({
  open,
  onOpenChange,
  client,
  initialValues,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  client?: Client | null;
  initialValues?: { name?: string; whatsapp?: string };
  onSaved?: (client: Client) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [whatsapp, setWhatsapp] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(client?.name ?? initialValues?.name ?? '');
    setWhatsapp(client ? formatWhatsapp(client.whatsapp) : (initialValues?.whatsapp ?? ''));
    setError(null);
    // Só ao abrir: os valores iniciais não devem sobrescrever o que está sendo digitado.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const mutation = useMutation({
    mutationFn: () => {
      const body = { name, whatsapp };
      return client
        ? api<{ client: Client }>(`/clients/${client.id}`, { method: 'PUT', body })
        : api<{ client: Client }>('/clients', { method: 'POST', body });
    },
    onSuccess: ({ client: saved }) => {
      queryClient.invalidateQueries({ queryKey: ['clients'] });
      toast.success(client ? 'Cliente atualizado.' : `${saved.name} cadastrado.`);
      onSaved?.(saved);
      onOpenChange(false);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Não foi possível salvar o cliente.'),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (name.trim().length < 2) return setError('Informe o nome do cliente.');
    if (!whatsapp.trim()) return setError('Informe o WhatsApp do cliente.');
    setError(null);
    mutation.mutate();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{client ? 'Editar cliente' : 'Novo cliente'}</DialogTitle>
          <DialogDescription>O orçamento em PDF é enviado para este WhatsApp.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          <Field label="Nome" htmlFor="cliente-nome">
            <Input
              id="cliente-nome"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="off"
              autoFocus
              required
            />
          </Field>
          <Field
            label="WhatsApp"
            htmlFor="cliente-whatsapp"
            error={error}
            hint="Com DDD. Número de outro país começa com +."
          >
            <Input
              id="cliente-whatsapp"
              value={whatsapp}
              onChange={(e) => setWhatsapp(e.target.value)}
              inputMode="tel"
              autoComplete="off"
              placeholder="(11) 98765-4321"
              aria-invalid={Boolean(error) || undefined}
              required
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" loading={mutation.isPending}>
              {client ? 'Salvar cliente' : 'Cadastrar cliente'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
