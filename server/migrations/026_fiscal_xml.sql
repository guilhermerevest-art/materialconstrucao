-- XML das notas guardado no banco, para o pacote do contador (e o SPED): o da nota
-- emitida é baixado da ACBr API uma vez; o da nota de compra vem com a entrada de
-- estoque; o da nota recebida pelo monitor, da ACBr API quando o pacote é montado.
alter table fiscal_documents add column xml text;
alter table stock_entries add column xml text;
alter table fiscal_inbound_documents add column xml text;
