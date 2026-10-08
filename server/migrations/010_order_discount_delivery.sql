-- Desconto no pedido inteiro (percentual ou valor) e endereço de entrega.
-- total_amount continua sendo o valor final (já com desconto): listagem, painel e
-- WhatsApp seguem lendo dele. subtotal_amount é a soma dos itens.
alter table orders add column subtotal_amount numeric(14, 2) not null default 0;
alter table orders add column discount_type   text check (discount_type in ('percent', 'amount'));
alter table orders add column discount_value  numeric(14, 2) check (discount_value > 0);
alter table orders add column discount_amount numeric(14, 2) not null default 0;
alter table orders add column delivery_address text;
alter table orders add constraint orders_discount_pair check ((discount_type is null) = (discount_value is null));

-- Pedidos de antes não têm desconto: subtotal = total. orders tem RLS forçado, que
-- vale também para o dono; sem desligá-lo o update não enxerga nenhum pedido.
alter table orders no force row level security;
update orders set subtotal_amount = total_amount;
alter table orders force row level security;
