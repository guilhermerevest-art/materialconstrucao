import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { createContext, useContext } from 'react';
import { api, ApiError } from './api';
import type { User } from './types';

export const ME_KEY = ['me'] as const;

/** Usuário logado; null quando não há sessão. */
export function useMe() {
  return useQuery({
    queryKey: ME_KEY,
    queryFn: async () => {
      try {
        return (await api<{ user: User }>('/auth/me')).user;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: Infinity,
    retry: false,
  });
}

/**
 * Preenchido pela rota protegida. Só muda quando ela renderiza com um usuário,
 * então as telas internas nunca veem a sessão "pela metade" durante o logout.
 */
export const UserContext = createContext<User | null>(null);

export function useUser(): User {
  const user = useContext(UserContext);
  if (!user) throw new Error('useUser fora da área logada');
  return user;
}

/** Descarta os dados da sessão anterior, menos o próprio usuário. */
function clearSessionData(queryClient: QueryClient) {
  queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== ME_KEY[0] });
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { tenant_slug?: string; username: string; password: string }) =>
      api<{ user: User }>('/auth/login', { method: 'POST', body: input }),
    onSuccess: ({ user }) => {
      clearSessionData(queryClient);
      queryClient.setQueryData(ME_KEY, user);
    },
  });
}

/** Lojamestre do domínio acessado (domínio próprio); null no endereço geral. */
export function useDomainTenant() {
  return useQuery({
    queryKey: ['domain-tenant'],
    queryFn: () => api<{ tenant: { name: string } | null }>('/auth/tenant').then((r) => r.tenant),
    staleTime: Infinity,
    retry: false,
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api<void>('/auth/logout', { method: 'POST' }),
    onSettled: () => {
      queryClient.setQueryData(ME_KEY, null);
      clearSessionData(queryClient);
    },
  });
}
