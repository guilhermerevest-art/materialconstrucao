-- Cancelamento: o pedido (ou o orçamento perdido) continua existindo, com quem
-- cancelou, quando e por quê. Excluir continua sendo só do admin e apaga de vez.
alter table orders drop constraint orders_status_check;
alter table orders add constraint orders_status_check check (status in ('quote', 'order', 'cancelled'));

-- O que o documento era antes de cancelar: orçamento perdido ou pedido cancelado.
alter table orders add column cancelled_from text check (cancelled_from in ('quote', 'order'));
alter table orders add column cancelled_at timestamptz;
alter table orders add column cancelled_by bigint references users (id);
alter table orders add column cancel_reason text;
alter table orders add constraint orders_cancel_fields check (
  (status = 'cancelled') = (cancelled_at is not null and cancelled_from is not null and cancelled_by is not null)
);
