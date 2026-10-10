-- Com quem falar no cliente: o "Olá, ...!" das mensagens usa o contato. Útil para
-- empresa (a construtora tem o comprador) e opcional para todo mundo.
alter table clients add column contact_name text;
