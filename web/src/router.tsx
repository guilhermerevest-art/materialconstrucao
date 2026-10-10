import { createBrowserRouter, Navigate, Outlet, useLocation } from 'react-router';
import { AppLayout } from './components/AppLayout';
import { Spinner } from './components/ui/misc';
import { useMe, UserContext } from './lib/auth';
import { ClientsPage } from './pages/ClientsPage';
import { DashboardPage } from './pages/DashboardPage';
import { FiscalDocumentsPage } from './pages/fiscal/FiscalDocumentsPage';
import { FiscalInboundPage } from './pages/fiscal/FiscalInboundPage';
import { LoginPage } from './pages/LoginPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { OrderDetailPage } from './pages/OrderDetailPage';
import { OrderEditorPage } from './pages/OrderEditorPage';
import { OrdersPage } from './pages/OrdersPage';
import { PaymentMethodsPage } from './pages/PaymentMethodsPage';
import { ProductsPage } from './pages/ProductsPage';
import { ReportsPage } from './pages/ReportsPage';
import { SettingsPage } from './pages/SettingsPage';
import { StoresPage } from './pages/StoresPage';
import { SuperLoginPage } from './pages/SuperLoginPage';
import { SuperTenantsPage } from './pages/SuperTenantsPage';
import { UsersPage } from './pages/UsersPage';

function FullPageSpinner() {
  return (
    <div className="grid min-h-dvh place-items-center">
      <Spinner />
    </div>
  );
}

function RequireAuth() {
  const { data: user, isPending, isError, refetch } = useMe();
  const location = useLocation();
  if (isPending) return <FullPageSpinner />;
  if (isError) {
    return (
      <div className="grid min-h-dvh place-items-center p-6 text-center">
        <div className="grid gap-3">
          <p className="font-medium">Não foi possível falar com o servidor.</p>
          <button className="text-sm font-semibold text-primary underline" onClick={() => refetch()}>
            Tentar de novo
          </button>
        </div>
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return (
    <UserContext value={user}>
      <AppLayout />
    </UserContext>
  );
}

function RequireAdmin() {
  const { data: user } = useMe();
  if (!user) return null;
  if (user.role !== 'admin') return <Navigate to="/" replace />;
  return <Outlet />;
}

function GuestOnly() {
  const { data: user, isPending } = useMe();
  if (isPending) return <FullPageSpinner />;
  if (user) return <Navigate to="/" replace />;
  return <Outlet />;
}

export const router = createBrowserRouter([
  {
    element: <GuestOnly />,
    children: [
      { path: '/login', element: <LoginPage /> },
    ],
  },
  // /super não passa por GuestOnly: o cookie oms_super_session não compartilha
  // a sessão da lojamestre, então um super admin pode ficar logado ao mesmo
  // tempo que um vendedor.
  { path: '/super/login', element: <SuperLoginPage /> },
  { path: '/super', element: <SuperTenantsPage /> },
  {
    path: '/',
    element: <RequireAuth />,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: 'pedidos', element: <OrdersPage /> },
      { path: 'pedidos/novo', element: <OrderEditorPage /> },
      { path: 'pedidos/:id', element: <OrderDetailPage /> },
      { path: 'pedidos/:id/editar', element: <OrderEditorPage /> },
      { path: 'clientes', element: <ClientsPage /> },
      { path: 'produtos', element: <ProductsPage /> },
      { path: 'relatorios', element: <ReportsPage /> },
      { path: 'fiscal', element: <FiscalDocumentsPage /> },
      {
        element: <RequireAdmin />,
        children: [
          { path: 'fiscal/recebidas', element: <FiscalInboundPage /> },
          { path: 'lojas', element: <StoresPage /> },
          { path: 'vendedores', element: <UsersPage /> },
          { path: 'formas-de-pagamento', element: <PaymentMethodsPage /> },
          { path: 'configuracoes', element: <SettingsPage /> },
        ],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
