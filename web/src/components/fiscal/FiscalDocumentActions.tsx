import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Ban, Download, FileCode2, MoreHorizontal, RefreshCw, RotateCcw, TriangleAlert, XCircle } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Field, Textarea } from '@/components/ui/input';
import { Alert, Badge } from '@/components/ui/misc';
import { api, ApiError } from '@/lib/api';
import { useUser } from '@/lib/auth';
import { modelLabel, STATUS_LABELS } from '@/lib/fiscal';
import type { FiscalDocument } from '@/lib/types';

export function FiscalStatusBadge({ status }: { status: FiscalDocument['status'] }) {
  const label = STATUS_LABELS[status];
  return <Badge variant={label.variant}>{label.text}</Badge>;
}

/**
 * O que falta para emitir, como o servidor devolveu, com o atalho para onde se
 * corrige cada coisa (empresa, cliente ou produto).
 */
export function FiscalProblems({ title, problems }: { title: string; problems: string[] }) {
  const user = useUser();
  const mentions = (pattern: RegExp) => problems.some((p) => pattern.test(p));
  const links = [
    user.role === 'admin' && mentions(/Configurações → Fiscal|empresa/) && { to: '/configuracoes?aba=fiscal', label: 'Dados da empresa' },
    mentions(/cliente/i) && { to: '/clientes', label: 'Cadastro do cliente' },
    user.role === 'admin' && mentions(/Produto "/) && { to: '/produtos', label: 'Produtos' },
  ].filter(Boolean) as { to: string; label: string }[];
  return (
    <Alert variant="danger" icon={<TriangleAlert />} title={title}>
      <ul className="mt-1 grid list-disc gap-1 pl-5 text-foreground">
        {problems.map((problem) => (
          <li key={problem}>{problem}</li>
        ))}
      </ul>
      {links.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {links.map((link) => (
            <Button key={link.to} asChild variant="outline" size="sm">
              <Link to={link.to}>Corrigir: {link.label}</Link>
            </Button>
          ))}
        </div>
      )}
    </Alert>
  );
}

type ReasonAction = 'cancel' | 'discard';

const REASON_COPY: Record<ReasonAction, { title: string; description: string; confirm: string }> = {
  cancel: {
    title: 'Cancelar a nota fiscal?',
    description:
      'O cancelamento vai para a SEFAZ e não tem volta. A NF-e pode ser cancelada em até 24 horas e a NFC-e em até 30 minutos depois da autorização (o prazo varia por UF).',
    confirm: 'Cancelar nota',
  },
  discard: {
    title: 'Inutilizar o número?',
    description:
      'A nota não foi autorizada. Inutilizar avisa a SEFAZ que este número não será usado, para a sequência não ficar com buraco. Depois disso o pedido pode ter outra nota.',
    confirm: 'Inutilizar número',
  },
};

function ReasonDialog({
  action,
  document,
  onOpenChange,
}: {
  action: ReasonAction | null;
  document: FiscalDocument;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      api<{ document: FiscalDocument }>(`/fiscal/documents/${document.id}/${action}`, { method: 'POST', body: { reason } }),
    onSuccess: ({ document: next }) => {
      void queryClient.invalidateQueries({ queryKey: ['fiscal-documents'] });
      toast.success(next.status === 'cancelado' || next.status === 'inutilizado' ? 'Pronto: a SEFAZ registrou.' : 'Pedido enviado à SEFAZ.');
      setReason('');
      onOpenChange(false);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Não foi possível concluir.'),
  });

  if (!action) return null;
  const copy = REASON_COPY[action];

  function submit(event: FormEvent) {
    event.preventDefault();
    if (reason.trim().length < 15) return setError('A justificativa precisa ter pelo menos 15 caracteres (exigência da SEFAZ).');
    setError(null);
    mutation.mutate();
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>
            {modelLabel(document.model)} nº {document.number}, série {document.series}. {copy.description}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          <Field label="Justificativa" htmlFor="nota-justificativa" error={error} hint="De 15 a 255 caracteres.">
            <Textarea
              id="nota-justificativa"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={255}
              autoFocus
              placeholder="Ex.: Cliente desistiu da compra antes da entrega"
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Voltar
            </Button>
            <Button type="submit" variant="destructive" loading={mutation.isPending}>
              {copy.confirm}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Atualizar situação, reenviar, DANFE, XML; cancelar e inutilizar ficam com o administrador. */
export function FiscalDocumentActions({ document }: { document: FiscalDocument }) {
  const user = useUser();
  const isAdmin = user.role === 'admin';
  const queryClient = useQueryClient();
  const [reasonAction, setReasonAction] = useState<ReasonAction | null>(null);
  const [problems, setProblems] = useState<string[] | null>(null);

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['fiscal-documents'] });

  const sync = useMutation({
    mutationFn: () => api<{ document: FiscalDocument }>(`/fiscal/documents/${document.id}/sync`, { method: 'POST' }),
    onSuccess: ({ document: next }) => {
      refresh();
      if (next.status !== document.status) toast.success(`Situação: ${STATUS_LABELS[next.status].text}.`);
      else toast('Situação sem mudança.');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Não foi possível consultar.'),
  });

  const retry = useMutation({
    mutationFn: () => api<{ document: FiscalDocument }>(`/fiscal/documents/${document.id}/retry`, { method: 'POST' }),
    onMutate: () => setProblems(null),
    onSuccess: ({ document: next }) => {
      refresh();
      if (next.status === 'autorizado') toast.success(`${modelLabel(next.model)} nº ${next.number} autorizada.`);
      else toast.error(next.status_message ?? `Situação: ${STATUS_LABELS[next.status].text}.`);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.problems?.length) setProblems(err.problems);
      else toast.error(err instanceof ApiError ? err.message : 'Não foi possível reenviar.');
    },
  });

  const base = `/api/fiscal/documents/${document.id}`;
  const canRetry = document.status === 'rejeitado' || document.status === 'erro';
  const canSync = document.status === 'pendente' || document.status === 'erro' || document.status === 'autorizado';

  return (
    <>
      <div className="flex flex-wrap items-center justify-end gap-1">
        {document.has_files && (
          <Button asChild variant="outline" size="sm">
            <a href={`${base}/pdf`} target="_blank" rel="noreferrer">
              <Download />
              DANFE
            </a>
          </Button>
        )}
        {canRetry && (
          <Button variant="steel" size="sm" onClick={() => retry.mutate()} loading={retry.isPending}>
            {!retry.isPending && <RotateCcw />}
            Reenviar
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-8" aria-label="Mais ações da nota">
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {canSync && (
              <DropdownMenuItem onSelect={() => sync.mutate()} disabled={sync.isPending}>
                <RefreshCw />
                Atualizar situação
              </DropdownMenuItem>
            )}
            {document.has_files && (
              <DropdownMenuItem asChild>
                <a href={`${base}/xml?download=1`}>
                  <FileCode2 />
                  Baixar XML
                </a>
              </DropdownMenuItem>
            )}
            {isAdmin && (document.status === 'autorizado' || canRetry) && <DropdownMenuSeparator />}
            {isAdmin && document.status === 'autorizado' && (
              <DropdownMenuItem onSelect={() => setReasonAction('cancel')} className="text-destructive">
                <XCircle />
                Cancelar nota
              </DropdownMenuItem>
            )}
            {isAdmin && canRetry && (
              <DropdownMenuItem onSelect={() => setReasonAction('discard')} className="text-destructive">
                <Ban />
                Inutilizar número
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {problems && (
        <div className="mt-2 text-left">
          <FiscalProblems title="Corrija antes de reenviar" problems={problems} />
        </div>
      )}
      <ReasonDialog action={reasonAction} document={document} onOpenChange={(open) => !open && setReasonAction(null)} />
    </>
  );
}
