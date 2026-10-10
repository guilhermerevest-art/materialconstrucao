import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import type { SetupArea } from './types';

/** Passos que contam para "pronto": os obrigatórios das áreas sem módulo e dos módulos ligados. */
export function requiredSteps(areas: SetupArea[]) {
  return areas.flatMap((a) => (a.module && !a.module.enabled ? [] : a.steps.filter((s) => !s.optional)));
}

/** Implantação: o que já está configurado na lojamestre (admin). */
export function useSetup(enabled = true) {
  return useQuery({
    queryKey: ['setup'],
    queryFn: () => api<{ areas: SetupArea[] }>('/setup').then((r) => r.areas),
    enabled,
  });
}
