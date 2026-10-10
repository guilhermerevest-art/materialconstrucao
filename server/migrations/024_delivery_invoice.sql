-- Entrega × nota fiscal: com a opção ligada, o romaneio só sai quando todos os pedidos
-- dele têm NF-e (ou NFC-e) autorizada. Desligada por padrão: a entrega funciona como antes.
alter table settings add column delivery_requires_invoice boolean not null default false;
