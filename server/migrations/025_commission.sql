-- Comissão sobre venda confirmada (menos devoluções; pedido cancelado não conta).
-- Sem percentual na loja nem no vendedor, não há comissão: o relatório só mostra as vendas.
alter table settings add column default_commission_percent numeric(5, 2)
  check (default_commission_percent between 0 and 100);
-- Percentual do vendedor; nulo usa o padrão da loja.
alter table users add column commission_percent numeric(5, 2) check (commission_percent between 0 and 100);
