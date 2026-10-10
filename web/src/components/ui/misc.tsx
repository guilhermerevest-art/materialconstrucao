import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/utils';

const badgeVariants = cva('inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap', {
  variants: {
    variant: {
      quote: 'bg-quote-soft text-quote',
      order: 'bg-order-soft text-order',
      success: 'bg-success-soft text-success',
      neutral: 'bg-muted text-muted-foreground',
      danger: 'bg-destructive-soft text-destructive',
      warning: 'bg-warning-soft text-warning',
      steel: 'bg-steel text-white',
    },
  },
  defaultVariants: { variant: 'neutral' },
});

export function Badge({ className, variant, ...props }: ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

const alertVariants = cva('flex gap-3 rounded-lg border p-4 text-sm [&>svg]:mt-0.5 [&>svg]:size-5 [&>svg]:shrink-0', {
  variants: {
    variant: {
      danger: 'border-destructive/30 bg-destructive-soft text-destructive [&_p]:text-foreground',
      success: 'border-success/30 bg-success-soft text-success [&_p]:text-foreground',
      info: 'border-border bg-card text-foreground',
    },
  },
  defaultVariants: { variant: 'info' },
});

export function Alert({
  className,
  variant,
  icon,
  title,
  children,
  ...props
}: Omit<ComponentProps<'div'>, 'title'> & VariantProps<typeof alertVariants> & { icon?: ReactNode; title: ReactNode }) {
  return (
    <div role={variant === 'danger' ? 'alert' : 'status'} className={cn(alertVariants({ variant }), className)} {...props}>
      {icon}
      <div className="grid min-w-0 flex-1 gap-1">
        <strong className="font-semibold">{title}</strong>
        {children}
      </div>
    </div>
  );
}

export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('animate-pulse rounded-md bg-muted', className)} {...props} />;
}

export function Kbd({ className, ...props }: ComponentProps<'kbd'>) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-card px-1 font-sans text-[11px] font-semibold text-muted-foreground shadow-[inset_0_-1px_0_var(--color-border)]',
        className,
      )}
      {...props}
    />
  );
}

export function Spinner({ className, label = 'Carregando' }: { className?: string; label?: string }) {
  return (
    <span role="status" className={cn('inline-flex items-center gap-2 text-sm text-muted-foreground', className)}>
      <Loader2 className="size-4 animate-spin" aria-hidden />
      {label}
    </span>
  );
}
