import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Field, Textarea } from './ui/input';
import { Alert } from './ui/misc';

/** Confirmação que pede um motivo (desmarcar entrega, não entregue, estorno...). */
export function ReasonDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  suggestions = [],
  loading,
  error,
  destructive = true,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  suggestions?: string[];
  loading?: boolean;
  error?: string | null;
  destructive?: boolean;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setReason('');
    setLocalError(null);
  }, [open]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (reason.trim().length < 3) return setLocalError('Informe o motivo.');
    setLocalError(null);
    onConfirm(reason.trim());
  }

  const shown = localError ?? error;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          {shown && <Alert variant="danger" title={shown} />}
          {suggestions.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {suggestions.map((option) => (
                <Button key={option} type="button" variant="outline" size="sm" onClick={() => setReason(option)}>
                  {option}
                </Button>
              ))}
            </div>
          )}
          <Field label="Motivo" htmlFor="motivo">
            <Textarea id="motivo" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} rows={3} autoFocus />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Voltar
            </Button>
            <Button type="submit" variant={destructive ? 'destructive' : 'default'} loading={loading}>
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
