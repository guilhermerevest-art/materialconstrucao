import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Circle, TriangleAlert } from 'lucide-react';
import { Link } from 'react-router';
import { PageHeader } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, Badge, Skeleton } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { useDocumentTitle } from '@/lib/hooks';
import type { SetupArea, SetupStep } from '@/lib/types';
import { cn } from '@/lib/utils';

/** Passos que contam para "pronto": os obrigatórios das áreas sem módulo e dos módulos ligados. */
export function requiredSteps(areas: SetupArea[]) {
  return areas.flatMap((a) => (a.module && !a.module.enabled ? [] : a.steps.filter((s) => !s.optional)));
}

export function useSetup(enabled = true) {
  return useQuery({
    queryKey: ['setup'],
    queryFn: () => api<{ areas: SetupArea[] }>('/setup').then((r) => r.areas),
    enabled,
  });
}

function StepIcon({ step }: { step: SetupStep }) {
  if (step.status === 'done') return <CheckCircle2 className="size-5 shrink-0 text-success" aria-label="Pronto" />;
  if (step.status === 'warning') return <TriangleAlert className="size-5 shrink-0 text-warning" aria-label="Atenção" />;
  return <Circle className="size-5 shrink-0 text-muted-foreground/60" aria-label="A fazer" />;
}

function AreaCard({ area }: { area: SetupArea }) {
  const off = area.module !== null && !area.module.enabled;
  const required = area.steps.filter((s) => !s.optional);
  const done = required.filter((s) => s.status === 'done').length;
  return (
    <Card>
      <CardHeader className="items-start">
        <div className="grid gap-1">
          <CardTitle className="flex flex-wrap items-center gap-2">
            {area.title}
            {area.module && <Badge variant={area.module.enabled ? 'success' : 'neutral'}>{area.module.enabled ? 'Ligado' : 'Desligado'}</Badge>}
          </CardTitle>
          <CardDescription>{area.description}</CardDescription>
        </div>
        {off ? (
          <Button asChild size="sm" variant="outline" className="shrink-0">
            <Link to={area.module!.link}>{area.key === 'fiscal' ? 'Configurar' : 'Ligar'}</Link>
          </Button>
        ) : (
          required.length > 0 && (
            <span className={cn('shrink-0 text-sm tabular-nums', done === required.length ? 'text-success' : 'text-muted-foreground')}>
              {done} de {required.length}
            </span>
          )
        )}
      </CardHeader>
      <ul className={cn('divide-y divide-border border-t border-border', off && 'opacity-60')}>
        {area.steps.map((step) => (
          <li key={step.key} className="flex flex-wrap items-start gap-3 px-5 py-3 sm:flex-nowrap">
            <StepIcon step={step} />
            <div className="grid min-w-0 flex-1 gap-0.5">
              <p className="flex flex-wrap items-center gap-2 font-medium">
                {step.title}
                {step.optional && <Badge>Opcional</Badge>}
              </p>
              <p className="text-sm text-muted-foreground">{step.description}</p>
              {step.detail && (
                <p className={cn('text-[13px] font-medium', step.status === 'warning' ? 'text-warning' : 'text-muted-foreground')}>{step.detail}</p>
              )}
            </div>
            {!off && step.status !== 'done' && (
              <Button asChild size="sm" variant={step.optional ? 'ghost' : 'outline'} className="ml-8 shrink-0 sm:ml-0">
                <Link to={step.link}>{step.action}</Link>
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

/**
 * Implantação: o que falta configurar, área por área, com o atalho para cada tela. Tudo é
 * lido do cadastro, então o passo fica pronto sozinho quando a loja configura.
 */
export function SetupPage() {
  useDocumentTitle('Implantação');
  const query = useSetup();
  const areas = query.data;
  const required = areas ? requiredSteps(areas) : [];
  const done = required.filter((s) => s.status === 'done').length;
  const percent = required.length ? Math.round((100 * done) / required.length) : 0;

  return (
    <div>
      <PageHeader
        title="Implantação"
        description="Passo a passo para colocar a loja no ar. Conforme você configura, os passos ficam prontos sozinhos."
      />
      {query.isError && <Alert variant="danger" title="Não foi possível carregar a implantação." />}
      {!areas ? (
        <div className="grid gap-4">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-48" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6">
          <Card>
            <CardContent className="grid gap-2 pt-5">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-medium">
                  {done === required.length ? 'Tudo pronto no que está ligado.' : `${done} de ${required.length} passos prontos`}
                </p>
                <span className="text-sm text-muted-foreground">Os opcionais e os módulos desligados não contam.</span>
              </div>
              <div className="h-2.5 w-full rounded-full bg-muted" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
                <div className="h-2.5 rounded-full bg-success transition-[width]" style={{ width: `${percent}%` }} />
              </div>
            </CardContent>
          </Card>
          {areas.map((area) => (
            <AreaCard key={area.key} area={area} />
          ))}
        </div>
      )}
    </div>
  );
}
