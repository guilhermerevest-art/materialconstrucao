-- Onde a 006 antiga chegou a rodar (como superusuário), find_login devolvia o
-- hash de senha de qualquer usuário a quem conectasse como `oms_login`. O login
-- não usa mais essas funções (veja a 006), então elas saem.
-- Elas pertencem ao superusuário: sem permissão para removê-las, só avisa.
-- O papel `oms_login`, se existir, fica sem acesso a nada; o superusuário pode
-- removê-lo com `drop owned by oms_login; drop role oms_login;`.
do $$
begin
  drop function if exists find_login(text, text);
  drop function if exists load_user_with_store(bigint);
exception when insufficient_privilege then
  raise warning 'Sem permissão para remover find_login e load_user_with_store. Como superusuário, rode: drop function find_login(text, text); drop function load_user_with_store(bigint);';
end $$;
