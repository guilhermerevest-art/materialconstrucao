import type { ComponentType } from 'react';
import { createBrowserRouter, Navigate, Outlet, useLocation } from 'react-router';
import { AppLayout } from './components/AppLayout';
import { Spinner } from './components/ui/misc';
import { useMe, UserContext } from './lib/auth';
import { ClientsPage } from './pages/ClientsPage';
import { DashboardPage } from './pages/DashboardPage';
import { DeliveriesPage } from './pages/DeliveriesPage';
import { DeliveryProofPage } from './pages/DeliveryProofPage';
import { LoginPage } from './pages/LoginPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { OrderDetailPage } from './pages/OrderDetailPage';
import { OrderEditorPage } from './pages/OrderEditorPage';
import { OrdersPage } from './pages/OrdersPage';
import { ProductsPage } from './pages/ProductsPage';
import { StockPage } from './pages/StockPage';

/** Tela usada por menos gente: o código vem só quando alguém abre (o pacote inicial fica menor no celular). */
function lazyPage(load: () => Promise<ComponentType>) {
  return async () => ({ Component: await load() });
}

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
  { path: '/super/login', HydrateFallback: FullPageSpinner, lazy: lazyPage(() => import('./pages/SuperLoginPage').then((m) => m.SuperLoginPage)) },
  { path: '/super', HydrateFallback: FullPageSpinner, lazy: lazyPage(() => import('./pages/SuperTenantsPage').then((m) => m.SuperTenantsPage)) },
  {
    path: '/',
    element: <RequireAuth />,
    // Abrindo direto uma tela carregada sob demanda, o spinner aparece enquanto o código chega.
    HydrateFallback: FullPageSpinner,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: 'pedidos', element: <OrdersPage /> },
      { path: 'pedidos/novo', element: <OrderEditorPage /> },
      { path: 'pedidos/:id', element: <OrderDetailPage /> },
      { path: 'pedidos/:id/editar', element: <OrderEditorPage /> },
      { path: 'pedidos/:id/conferencia', lazy: lazyPage(() => import('./pages/ConferencePage').then((m) => m.ConferencePage)) },
      { path: 'clientes', element: <ClientsPage /> },
      { path: 'produtos', element: <ProductsPage /> },
      { path: 'relatorios', lazy: lazyPage(() => import('./pages/ReportsPage').then((m) => m.ReportsPage)) },
      { path: 'monitor', lazy: lazyPage(() => import('./pages/MonitorPage').then((m) => m.MonitorPage)) },
      { path: 'estoque', element: <StockPage /> },
      { path: 'entregas', element: <DeliveriesPage /> },
      { path: 'entregas/:id', element: <DeliveryProofPage /> },
      { path: 'caixa', lazy: lazyPage(() => import('./pages/CashPage').then((m) => m.CashPage)) },
      { path: 'contas-a-receber', lazy: lazyPage(() => import('./pages/ReceivablesPage').then((m) => m.ReceivablesPage)) },
      { path: 'fiado', lazy: lazyPage(() => import('./pages/FiadoPage').then((m) => m.FiadoPage)) },
      { path: 'fiado/:clientId', lazy: lazyPage(() => import('./pages/FiadoAccountPage').then((m) => m.FiadoAccountPage)) },
      { path: 'fiscal', lazy: lazyPage(() => import('./pages/fiscal/FiscalDocumentsPage').then((m) => m.FiscalDocumentsPage)) },
      {
        element: <RequireAdmin />,
        children: [
          { path: 'fiscal/recebidas', lazy: lazyPage(() => import('./pages/fiscal/FiscalInboundPage').then((m) => m.FiscalInboundPage)) },
          { path: 'fiscal/contador', lazy: lazyPage(() => import('./pages/fiscal/FiscalAccountantPage').then((m) => m.FiscalAccountantPage)) },
          { path: 'lojas', lazy: lazyPage(() => import('./pages/StoresPage').then((m) => m.StoresPage)) },
          { path: 'vendedores', lazy: lazyPage(() => import('./pages/UsersPage').then((m) => m.UsersPage)) },
          { path: 'formas-de-pagamento', lazy: lazyPage(() => import('./pages/PaymentMethodsPage').then((m) => m.PaymentMethodsPage)) },
          { path: 'tabelas-de-preco', lazy: lazyPage(() => import('./pages/PriceListsPage').then((m) => m.PriceListsPage)) },
          { path: 'fluxo-de-pedidos', lazy: lazyPage(() => import('./pages/WorkflowsPage').then((m) => m.WorkflowsPage)) },
          { path: 'estoque/entrada', lazy: lazyPage(() => import('./pages/StockEntryPage').then((m) => m.StockEntryPage)) },
          { path: 'compras', lazy: lazyPage(() => import('./pages/purchases/PurchasesPage').then((m) => m.PurchasesPage)) },
          { path: 'compras/novo', lazy: lazyPage(() => import('./pages/purchases/PurchaseOrderEditorPage').then((m) => m.PurchaseOrderEditorPage)) },
          { path: 'compras/:id', lazy: lazyPage(() => import('./pages/purchases/PurchaseOrderPage').then((m) => m.PurchaseOrderPage)) },
          { path: 'compras/:id/editar', lazy: lazyPage(() => import('./pages/purchases/PurchaseOrderEditorPage').then((m) => m.PurchaseOrderEditorPage)) },
          { path: 'contas-a-pagar', lazy: lazyPage(() => import('./pages/PayablesPage').then((m) => m.PayablesPage)) },
          { path: 'configuracoes', lazy: lazyPage(() => import('./pages/SettingsPage').then((m) => m.SettingsPage)) },
          { path: 'implantacao', lazy: lazyPage(() => import('./pages/SetupPage').then((m) => m.SetupPage)) },
        ],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
