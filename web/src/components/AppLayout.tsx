import { ChevronDown, KeyRound, LogOut, Menu, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { useLogout, useUser } from '@/lib/auth';
import { initials } from '@/lib/format';
import { cn } from '@/lib/utils';
import { ChangePasswordDialog } from './ChangePasswordDialog';
import { BrandMark } from './shared';
import { Button } from './ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';

type NavItem = { to: string; label: string; end?: boolean };
type NavGroup = { label: string; items: NavItem[]; adminOnly?: boolean; finance?: boolean };

// O que se usa o dia inteiro fica direto na barra; o resto, agrupado por área,
// para a barra caber em telas de 1280 px mesmo com o menu do administrador.
const NAV: (NavItem | NavGroup)[] = [
  { to: '/', label: 'Início', end: true },
  { to: '/pedidos', label: 'Pedidos' },
  { to: '/clientes', label: 'Clientes' },
  { to: '/produtos', label: 'Produtos' },
  {
    label: 'Operação',
    items: [
      { to: '/monitor', label: 'Monitor' },
      { to: '/fiscal', label: 'Notas fiscais' },
      { to: '/entregas', label: 'Entregas' },
      { to: '/estoque', label: 'Estoque' },
    ],
  },
  {
    label: 'Financeiro',
    finance: true,
    items: [
      { to: '/caixa', label: 'Caixa' },
      { to: '/contas-a-receber', label: 'Contas a receber' },
    ],
  },
  { to: '/relatorios', label: 'Relatórios' },
  {
    label: 'Administração',
    adminOnly: true,
    items: [
      { to: '/lojas', label: 'Lojas' },
      { to: '/vendedores', label: 'Vendedores' },
      { to: '/formas-de-pagamento', label: 'Formas de pagamento' },
      { to: '/tabelas-de-preco', label: 'Tabelas de preço' },
      { to: '/fluxo-de-pedidos', label: 'Fluxo de pedidos' },
      { to: '/configuracoes', label: 'Configurações' },
    ],
  },
];

const isGroup = (entry: NavItem | NavGroup): entry is NavGroup => 'items' in entry;

const navItemClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    'flex h-14 items-center px-2 text-sm font-medium whitespace-nowrap transition-colors xl:px-3',
    isActive ? 'text-white shadow-[inset_0_-3px_0_var(--color-primary)]' : 'text-white/70 hover:text-white',
  );

function MobileLink({ item, onClick }: { item: NavItem; onClick: () => void }) {
  return (
    <NavLink
      to={item.to}
      end={item.end}
      onClick={onClick}
      className={({ isActive }) =>
        cn(
          'block rounded-md px-3 py-2.5 text-sm font-medium',
          isActive ? 'bg-white/10 text-white' : 'text-white/75 hover:bg-white/5 hover:text-white',
        )
      }
    >
      {item.label}
    </NavLink>
  );
}

export function AppLayout() {
  const user = useUser();
  const isAdmin = user.role === 'admin';
  const location = useLocation();
  const navigate = useNavigate();
  const logout = useLogout();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  // Financeiro só aparece quando está ligado na lojamestre.
  const nav = NAV.filter((entry) => !isGroup(entry) || ((!entry.adminOnly || isAdmin) && (!entry.finance || user.finance_enabled)));
  const groupActive = (group: NavGroup) => group.items.some((item) => location.pathname.startsWith(item.to));

  async function handleLogout() {
    await logout.mutateAsync().catch(() => {});
    navigate('/login', { replace: true });
    toast.success('Você saiu do sistema.');
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-40 bg-steel text-white">
        <div className="mx-auto flex h-14 max-w-[1400px] items-center gap-4 px-4 lg:px-6">
          <Link to="/" className="flex items-center gap-2.5 rounded-md pr-2 font-bold tracking-tight">
            <BrandMark className="size-7" />
            <span className="text-[17px] whitespace-nowrap">Gestão de Loja</span>
          </Link>

          <nav className="ml-2 hidden items-center lg:flex" aria-label="Principal">
            {nav.map((entry) =>
              isGroup(entry) ? (
                <DropdownMenu key={entry.label}>
                  <DropdownMenuTrigger
                    className={cn(navItemClass({ isActive: groupActive(entry) }), 'gap-1 data-[state=open]:text-white')}
                  >
                    {entry.label}
                    <ChevronDown className="size-4" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    {entry.items.map((item) => (
                      <DropdownMenuItem key={item.to} onSelect={() => navigate(item.to)}>
                        {item.label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                <NavLink key={entry.to} to={entry.to} end={entry.end} className={navItemClass}>
                  {entry.label}
                </NavLink>
              ),
            )}
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <Button asChild size="sm" className="hidden sm:inline-flex lg:hidden xl:inline-flex">
              <Link to="/pedidos/novo">
                <Plus />
                Novo pedido
              </Link>
            </Button>
            <Button asChild size="icon" className="sm:hidden lg:inline-flex xl:hidden" aria-label="Novo pedido">
              <Link to="/pedidos/novo">
                <Plus />
              </Link>
            </Button>

            <DropdownMenu>
              <DropdownMenuTrigger className="flex items-center gap-2.5 rounded-md py-1 pr-1 pl-2 text-left hover:bg-white/10">
                <span className="hidden text-right leading-tight xl:block">
                  <span className="block text-sm font-medium">{user.name}</span>
                  <span className="block text-xs text-white/65">
                    {isAdmin ? 'Administrador' : (user.store_name ?? 'Vendedor')}
                  </span>
                </span>
                <span className="grid size-8 place-items-center rounded-full bg-white/15 text-xs font-semibold">
                  {initials(user.name)}
                </span>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>
                  <span className="block font-medium">{user.name}</span>
                  <span className="block text-xs text-muted-foreground">{user.email ?? user.username}</span>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setPasswordOpen(true)}>
                  <KeyRound />
                  Alterar senha
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={handleLogout}>
                  <LogOut />
                  Sair
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <button
              className="grid size-9 place-items-center rounded-md hover:bg-white/10 lg:hidden"
              onClick={() => setMobileOpen((open) => !open)}
              aria-expanded={mobileOpen}
              aria-controls="menu-movel"
              aria-label={mobileOpen ? 'Fechar menu' : 'Abrir menu'}
            >
              {mobileOpen ? <X className="size-5" /> : <Menu className="size-5" />}
            </button>
          </div>
        </div>

        {mobileOpen && (
          <nav id="menu-movel" className="border-t border-white/10 px-2 pb-3 lg:hidden" aria-label="Principal">
            {nav.map((entry) =>
              isGroup(entry) ? (
                <div key={entry.label} className="mt-2">
                  <p className="px-3 pt-1 pb-1 text-[11px] font-semibold tracking-wide text-white/45 uppercase">{entry.label}</p>
                  {entry.items.map((item) => (
                    <MobileLink key={item.to} item={item} onClick={() => setMobileOpen(false)} />
                  ))}
                </div>
              ) : (
                <MobileLink key={entry.to} item={entry} onClick={() => setMobileOpen(false)} />
              ),
            )}
          </nav>
        )}
      </header>

      <main className="flex-1">
        <div className="mx-auto max-w-[1400px] px-4 py-6 lg:px-6 lg:py-8">
          <Outlet />
        </div>
      </main>

      <ChangePasswordDialog open={passwordOpen} onOpenChange={setPasswordOpen} />
    </div>
  );
}
