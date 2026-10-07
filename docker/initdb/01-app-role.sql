-- A aplicação conecta com um usuário comum (não superusuário): superusuários
-- ignoram Row Level Security, e o isolamento entre lojas depende dele.
create role oms login password 'oms';
create database oms owner oms;
create database oms_test owner oms;
