import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api, ApiError } from './api';
import type { Tenant } from './types';

export const SUPER_ME_KEY = ['super-me'] as const;

export type SuperAdminPublic = { id: number; email: string; active: boolean };

/** Super admin logado; null quando não há sessão. */
export function useMeSuper() {
  return useQuery({
    queryKey: SUPER_ME_KEY,
    queryFn: async () => {
      try {
        return (await api<{ super_admin: SuperAdminPublic }>('/super/me')).super_admin;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: Infinity,
    retry: false,
  });
}

export function useSuperLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { email: string; password: string }) =>
      api<{ super_admin: SuperAdminPublic }>('/super/login', { method: 'POST', body: input }),
    onSuccess: ({ super_admin }) => {
      queryClient.setQueryData(SUPER_ME_KEY, super_admin);
    },
  });
}

function clearSuperData(queryClient: QueryClient) {
  queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== SUPER_ME_KEY[0] });
}

export function useSuperLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api<void>('/super/logout', { method: 'POST' }),
    onSettled: () => {
      queryClient.setQueryData(SUPER_ME_KEY, null);
      clearSuperData(queryClient);
    },
  });
}

export function useSuperTenants() {
  return useQuery({
    queryKey: ['super-tenants'],
    queryFn: () => api<{ items: Tenant[] }>('/super/tenants').then((r) => r.items),
  });
}

export function useCreateTenant() {
  return useMutation({
    mutationFn: (input: {
      slug: string;
      name: string;
      admin_name: string;
      admin_username: string;
      admin_password: string;
      admin_email?: string;
      domains?: string[];
    }) =>
      api<{
        tenant: { id: number; slug: string; name: string; created_at: string };
        admin: { id: number; username: string };
      }>('/super/tenants', { method: 'POST', body: input }),
  });
}

export function useUpdateTenant() {
  return useMutation({
    mutationFn: ({
      tenantId,
      ...input
    }: {
      tenantId: number;
      slug: string;
      name: string;
      active: boolean;
      domains: string[];
    }) =>
      api<{ tenant: Pick<Tenant, 'id' | 'slug' | 'name' | 'active' | 'domains'> }>(`/super/tenants/${tenantId}`, {
        method: 'PUT',
        body: input,
      }),
  });
}
