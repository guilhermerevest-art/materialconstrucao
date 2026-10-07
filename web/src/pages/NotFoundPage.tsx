import { Link } from 'react-router';
import { EmptyState } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { useDocumentTitle } from '@/lib/hooks';

export function NotFoundPage() {
  useDocumentTitle('Página não encontrada');
  return (
    <EmptyState
      title="Página não encontrada"
      description="O endereço pode estar errado ou o registro foi excluído."
      action={
        <Button asChild>
          <Link to="/">Ir para o início</Link>
        </Button>
      }
    />
  );
}
