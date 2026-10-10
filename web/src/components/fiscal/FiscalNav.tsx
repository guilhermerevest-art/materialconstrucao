import { Briefcase, FileOutput, Inbox } from 'lucide-react';
import { NavLink } from 'react-router';
import { useUser } from '@/lib/auth';
import { cn } from '@/lib/utils';

const linkClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    '-mb-px inline-flex h-10 items-center gap-2 border-b-2 px-3 text-sm font-medium whitespace-nowrap transition-colors [&_svg]:size-4',
    isActive ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
  );

/** Abas do módulo fiscal. O monitor de notas recebidas e o pacote do contador são do administrador. */
export function FiscalNav() {
  const user = useUser();
  return (
    <nav className="mb-4 flex gap-1 overflow-x-auto border-b border-border" aria-label="Fiscal">
      <NavLink to="/fiscal" end className={linkClass}>
        <FileOutput />
        Notas emitidas
      </NavLink>
      {user.role === 'admin' && (
        <NavLink to="/fiscal/recebidas" className={linkClass}>
          <Inbox />
          Notas recebidas (monitor)
        </NavLink>
      )}
      {user.role === 'admin' && (
        <NavLink to="/fiscal/contador" className={linkClass}>
          <Briefcase />
          Contador
        </NavLink>
      )}
    </nav>
  );
}
