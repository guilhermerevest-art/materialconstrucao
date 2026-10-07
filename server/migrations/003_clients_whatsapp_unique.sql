-- O cliente é reconhecido pelo WhatsApp: é por ele que o orçamento é enviado e
-- que o vendedor sabe com quem está falando. Dois cadastros para o mesmo número
-- fragmentam o histórico de pedidos entre duas fichas e fazem o mesmo cliente
-- aparecer duas vezes no atendimento. Por isso o WhatsApp passa a ser único.

-- A verificação dos pedidos abaixo só funciona enxergando a tabela inteira. As
-- políticas de RLS de orders liberam linhas quando app.role está definido na
-- transação (é o que a API faz a cada requisição) e sem isso a consulta voltaria
-- vazia, e um cliente com pedidos passaria por duplicado descartável.
select set_config('app.role', 'admin', true);

do $$
declare
  conflitos text;
begin
  -- Duplicado é o cadastro que não é o de menor id do seu WhatsApp.
  -- Se algum deles já tem pedidos, não dá para apagar sozinho: quem decide é uma
  -- pessoa. O próprio índice único ainda aborta a migration nesse caso.
  select string_agg(linha, '; ' order by linha)
    into conflitos
    from (
      select c.whatsapp || ': ' || '"' || c.name || '" (id ' || c.id || ')' as linha
      from clients c
      where exists (
              select 1 from clients anterior
              where anterior.whatsapp = c.whatsapp and anterior.id < c.id)
        and exists (select 1 from orders o where o.client_id = c.id)
    ) d;

  if conflitos is not null then
    raise exception using
      message = 'Não foi possível unificar o WhatsApp. Estes cadastros duplicados têm'
                || ' pedidos vinculados e precisam ser decididos manualmente: '
                || conflitos,
      hint = 'Mova ou apague os pedidos para um único cadastro e rode a migração de novo.';
  end if;

  -- Sem histórico, some com o cadastro repetido e fica o de menor id.
  delete from clients c
  where exists (
          select 1 from clients anterior
          where anterior.whatsapp = c.whatsapp and anterior.id < c.id);
end $$;

create unique index clients_whatsapp_key on clients (whatsapp);