import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { Toaster } from 'sonner';
import './index.css';
import { ApiError, setUnauthorizedHandler } from './lib/api';
import { ME_KEY } from './lib/auth';
import { router } from './router';

const retryUnlessClientError = (failureCount: number, error: unknown) =>
  !(error instanceof ApiError && error.status >= 400 && error.status < 500) && failureCount < 2;

const queryClient = new QueryClient({
  queryCache: new QueryCache(),
  mutationCache: new MutationCache(),
  defaultOptions: {
    queries: { retry: retryUnlessClientError, staleTime: 15_000, refetchOnWindowFocus: false },
  },
});

// Sessão expirou no meio do uso: volta para o login.
setUnauthorizedHandler(() => {
  queryClient.setQueryData(ME_KEY, null);
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster position="top-center" offset={68} richColors closeButton toastOptions={{ duration: 5000 }} />
    </QueryClientProvider>
  </StrictMode>,
);
